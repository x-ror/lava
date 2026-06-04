#+build windows
package eventloop

import "core:sys/windows"

// Спеціальний маркер для міжпотокових сигналів пробудження,
// який гарантовано не буде конфліктувати з реальними адресами пам'яті вочерів
WAKEUP_KEY :: windows.ULONG_PTR(1)

Platform_Loop :: struct {
	iocp: windows.HANDLE,
}

platform_name :: proc(loop: ^Loop) -> string {
	return "windows-iocp"
}

platform_init :: proc(loop: ^Loop) -> bool {
	// Створюємо базовий порт завершення вводу-виводу (IOCP)
	// Останній параметр (0) дозволяє системі динамічно оптимізувати потоки під кількість ядер
	loop.platform.iocp = windows.CreateIoCompletionPort(windows.INVALID_HANDLE_VALUE, nil, 0, 0)
	return loop.platform.iocp != nil
}

platform_destroy :: proc(loop: ^Loop) {
	if loop.platform.iocp != nil {
		windows.CloseHandle(loop.platform.iocp)
		loop.platform.iocp = nil
	}
}

platform_wakeup :: proc(loop: ^Loop) {
	// Надсилаємо штучний пакет завершення в чергу порту, щоб миттєво розбудити системний виклик очікування
	windows.PostQueuedCompletionStatus(loop.platform.iocp, 0, WAKEUP_KEY, nil)
}

platform_watch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	handle := windows.HANDLE(watcher.fd)

	// Прив'язуємо хендл сокету/файлу до порту IOCP.
	// Передаємо вказівник на IO_Watcher як CompletionKey — ядро поверне його нам при завершенні операції.
	// Примітка: В IOCP один виклик реєструє хендл і на Читання, і на Запис (параметр watcher.mode не потрібен тут).
	res := windows.CreateIoCompletionPort(
		handle,
		loop.platform.iocp,
		windows.ULONG_PTR(uintptr(watcher)),
		0,
	)
	return res != nil
}

platform_unwatch_fd :: proc(loop: ^Loop, watcher: ^IO_Watcher) -> bool {
	// В архітектурі Windows IOCP неможливо явно "відв'язати" дескриптор від порту.
	// Хендл автоматично видаляється з IOCP, коли ви закриваєте сам сокет або файл (CloseHandle/closesocket).
	// Повертаємо true, оскільки закриття ресурсу на стороні рантайму виконає цю роботу за нас.
	return true
}

platform_poll :: proc(loop: ^Loop, timeout_ms: int) {
	entries: [32]windows.OVERLAPPED_ENTRY
	removed: windows.c_ulong

	timeout := windows.INFINITE if timeout_ms < 0 else windows.DWORD(timeout_ms)

	ok := windows.GetQueuedCompletionStatusEx(
		loop.platform.iocp,
		&entries[0],
		len(entries),
		&removed,
		timeout,
		false,
	)
	if !ok || removed == 0 do return

	for i in 0 ..< int(removed) {
		key := entries[i].lpCompletionKey
		if key == WAKEUP_KEY || key == 0 do continue

		watcher := cast(^IO_Watcher)uintptr(key)
		if watcher.callback != nil {
			loop.io_events += 1
			watcher.callback(loop, watcher.user_data)
		}
	}
}
