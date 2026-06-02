package main

import "core:fmt"
import "core:os"

VERSION :: "0.1.0-dev"

main :: proc() {
	args := os.args

	if len(args) < 2 {
		print_help()
		return
	}

	switch args[1] {
	case "--help", "-h", "help":
		print_help()
	case "--version", "-v":
		fmt.println("lava", VERSION)
	case "eval":
		eval_command(args[2:])
	case "run":
		run_command(args[2:])
	case:
		fmt.eprintfln("unknown command: %s", args[1])
		fmt.eprintln("try `lava --help`")
		os.exit(2)
	}
}

print_help :: proc() {
	fmt.println(`Lava - an Odin and JavaScriptCore runtime toolkit

Usage:
  lava eval <source>    Evaluate JavaScript source
  lava run <file>       Run a JavaScript file
  lava --version        Print version
  lava --help           Print help

The CLI is initialized. JSC evaluation will be wired in once the local
JavaScriptCore development package is available.`)
}

eval_command :: proc(args: []string) {
	if len(args) < 1 {
		fmt.eprintln("usage: lava eval <source>")
		os.exit(2)
	}

	fmt.println("JSC runtime is not linked yet.")
	fmt.printfln("queued source: %s", args[0])
}

run_command :: proc(args: []string) {
	if len(args) < 1 {
		fmt.eprintln("usage: lava run <file>")
		os.exit(2)
	}

	data, err := os.read_entire_file(args[0], context.allocator)
	if err != os.ERROR_NONE {
		fmt.eprintfln("could not read %s: %v", args[0], err)
		os.exit(1)
	}
	defer delete(data)

	fmt.println("JSC runtime is not linked yet.")
	fmt.printfln("queued file: %s (%d bytes)", args[0], len(data))
}
