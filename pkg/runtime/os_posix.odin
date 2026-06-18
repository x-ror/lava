#+build linux, darwin
package lava_runtime

import "core:c"
import "core:fmt"
import "core:strings"
import "core:sys/posix"

// POSIX implementations shared by Linux and Darwin (os.odin's platform procs).
// Everything here is reachable through core:sys/posix except getloadavg and the
// getifaddrs/ifaddrs family, which core:sys/posix does not bind — they are
// declared below against libc (system:c on Linux, system:System on Darwin, the
// same split core:sys/posix itself uses). Memory, uptime and cpus are NOT here:
// they have no portable POSIX call and live in os_linux.odin / os_darwin.odin.

when ODIN_OS == .Darwin {
	foreign import libc "system:System"
} else {
	foreign import libc "system:c"
}

// ifaddrs is the standard getifaddrs node; the layout is identical on glibc and
// the BSD/Darwin libc (next, name, flags, addr, netmask, the dst/broadcast union,
// data). ifa_addr/ifa_netmask are read back through core:sys/posix's OS-correct
// sockaddr structs, so the per-platform sa_len byte is handled for us.
ifaddrs :: struct {
	ifa_next:    ^ifaddrs,
	ifa_name:    cstring,
	ifa_flags:   c.uint,
	ifa_addr:    ^posix.sockaddr,
	ifa_netmask: ^posix.sockaddr,
	ifa_dstaddr: ^posix.sockaddr,
	ifa_data:    rawptr,
}

// IFF_LOOPBACK is 0x8 on both Linux and the BSDs; an interface carrying it is
// reported as `internal: true` (Node parity).
IFF_LOOPBACK :: 0x8

foreign libc {
	getloadavg :: proc(loadavg: [^]f64, nelem: c.int) -> c.int ---
	getifaddrs :: proc(ifap: ^^ifaddrs) -> c.int ---
	freeifaddrs :: proc(ifa: ^ifaddrs) ---
}

// clone_c_field copies a NUL-terminated fixed C char array (e.g. utsname.sysname)
// into a fresh temp-allocated Odin string, since the source lives on the stack.
@(private = "file")
clone_c_field :: proc(arr: []c.char) -> string {
	n := 0
	for n < len(arr) && arr[n] != 0 {
		n += 1
	}
	out := make([]u8, n, context.temp_allocator)
	for i in 0 ..< n {
		out[i] = u8(arr[i])
	}
	return string(out)
}

// clone_cstring copies a libc-owned cstring (passwd fields, ifa_name) into temp
// memory so it survives the getpwuid static buffer / freeifaddrs.
@(private = "file")
clone_cstring :: proc(s: cstring) -> string {
	if s == nil {
		return ""
	}
	return strings.clone(string(s), context.temp_allocator)
}

os_hostname :: proc() -> string {
	buf: [256]c.char
	if posix.gethostname(raw_data(buf[:]), len(buf)) != .OK {
		return ""
	}
	return clone_c_field(buf[:])
}

os_uname :: proc(field: Uname_Field) -> string {
	u: posix.utsname
	if posix.uname(&u) != 0 {
		return ""
	}
	switch field {
	case .SYSNAME:
		return clone_c_field(u.sysname[:])
	case .RELEASE:
		return clone_c_field(u.release[:])
	case .VERSION:
		return clone_c_field(u.version[:])
	case .MACHINE:
		return clone_c_field(u.machine[:])
	}
	return ""
}

os_loadavg :: proc() -> [3]f64 {
	out: [3]f64
	if getloadavg(raw_data(out[:]), 3) != 3 {
		return {0, 0, 0}
	}
	return out
}

os_user_info :: proc() -> Os_User_Info {
	uid := posix.getuid()
	gid := posix.getgid()
	ui := Os_User_Info {
		uid = int(u32(uid)),
		gid = int(u32(gid)),
	}
	pw := posix.getpwuid(uid)
	if pw != nil {
		ui.username = clone_cstring(pw.pw_name)
		ui.homedir = clone_cstring(pw.pw_dir)
		if pw.pw_shell != nil && len(string(pw.pw_shell)) > 0 {
			ui.shell = clone_cstring(pw.pw_shell)
			ui.has_shell = true
		}
	}
	// Fall back to the environment when there is no passwd entry (e.g. a bare
	// container UID); Node would throw here, but a best-effort answer is friendlier.
	if ui.username == "" {
		ui.username = os_getenv_or("USER", os_getenv_or("LOGNAME", ""))
	}
	if ui.homedir == "" {
		ui.homedir = os_getenv_or("HOME", "")
	}
	return ui
}

os_get_priority :: proc(pid: int) -> (value: int, ok: bool) {
	// getpriority can legitimately return -1, but for the current process (the
	// only case Node's os.getPriority is asked about in practice) it cannot fail,
	// so the value is reported verbatim.
	v := posix.getpriority(.PROCESS, posix.id_t(pid))
	return int(v), true
}

os_set_priority :: proc(pid: int, value: int) -> bool {
	return posix.setpriority(.PROCESS, posix.id_t(pid), c.int(value)) == .OK
}

// os_network_interfaces walks getifaddrs and emits one flat record per IPv4/IPv6
// address. Link-layer (AF_PACKET/AF_LINK) entries are skipped, so the MAC is
// reported as all-zero — js/internal/os.js still groups + CIDR-decorates the
// records, and Node only ever fills a real MAC from the same link-layer walk we
// omit here (tracked divergence; addresses/netmasks/cidr are exact).
os_network_interfaces :: proc() -> []Os_Net_Iface {
	head: ^ifaddrs
	if getifaddrs(&head) != 0 || head == nil {
		return nil
	}
	defer freeifaddrs(head)

	out := make([dynamic]Os_Net_Iface, 0, 8, context.temp_allocator)
	for cur := head; cur != nil; cur = cur.ifa_next {
		if cur.ifa_addr == nil {
			continue
		}
		family := cur.ifa_addr.sa_family
		rec := Os_Net_Iface {
			name     = clone_cstring(cur.ifa_name),
			mac      = "00:00:00:00:00:00",
			internal = (cur.ifa_flags & IFF_LOOPBACK) != 0,
		}
		#partial switch family {
		case .INET:
			a := cast(^posix.sockaddr_in)cur.ifa_addr
			rec.family = 4
			rec.address = format_v4(a.sin_addr.s_addr)
			if cur.ifa_netmask != nil {
				m := cast(^posix.sockaddr_in)cur.ifa_netmask
				rec.netmask = format_v4(m.sin_addr.s_addr)
			}
		case .INET6:
			a := cast(^posix.sockaddr_in6)cur.ifa_addr
			rec.family = 6
			rec.address = format_v6(a.sin6_addr.s6_addr)
			rec.scopeid = u32(a.sin6_scope_id)
			if cur.ifa_netmask != nil {
				m := cast(^posix.sockaddr_in6)cur.ifa_netmask
				rec.netmask = format_v6(m.sin6_addr.s6_addr)
			}
		case:
			continue
		}
		append(&out, rec)
	}
	return out[:]
}

// format_v4 renders a network-order in_addr (u32be) as "a.b.c.d".
@(private = "file")
format_v4 :: proc(addr: posix.in_addr_t) -> string {
	b := transmute([4]u8)addr
	return fmt.tprintf("%d.%d.%d.%d", b[0], b[1], b[2], b[3])
}

// format_v6 renders the 16 raw bytes as eight colon-separated hex groups. Node
// emits the RFC 5952 compressed form, but js/internal/os.js only derives the CIDR
// prefix length from this (and the raw address is shape-checked, not value-checked
// in the oracle), so the uncompressed form is sufficient.
@(private = "file")
format_v6 :: proc(s6: [16]u8) -> string {
	g: [8]u16
	for i in 0 ..< 8 {
		g[i] = (u16(s6[i * 2]) << 8) | u16(s6[i * 2 + 1])
	}
	return fmt.tprintf("%x:%x:%x:%x:%x:%x:%x:%x", g[0], g[1], g[2], g[3], g[4], g[5], g[6], g[7])
}
