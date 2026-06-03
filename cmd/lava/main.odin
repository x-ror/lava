package main

import "core:fmt"
import "core:os"
import lava_runtime "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

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
	fmt.println(
		`Lava - an Odin and JavaScriptCore runtime toolkit

Usage:
  lava eval <source>    Evaluate JavaScript source
  lava run <file>       Run a JavaScript file
  lava --version        Print version
  lava --help           Print help

The CLI is initialized. JSC evaluation will be wired in once the local
JavaScriptCore development package is available.`,
	)
}

eval_command :: proc(args: []string) {
	if len(args) < 1 {
		fmt.eprintln("usage: lava eval <source>")
		os.exit(2)
	}

	loop := eventloop.init()
	result := lava_runtime.eval(args[0], "<eval>", &loop, true)
	print_result(result)
	exit_code := result.exit_code
	lava_runtime.result_destroy(&result)
	os.exit(exit_code)
}

run_command :: proc(args: []string) {
	if len(args) < 1 {
		fmt.eprintln("usage: lava run <file>")
		os.exit(2)
	}

	loop := eventloop.init()
	result := lava_runtime.run_file(args[0], &loop)
	print_result(result)
	exit_code := result.exit_code
	lava_runtime.result_destroy(&result)
	os.exit(exit_code)
}

print_result :: proc(result: lava_runtime.Result) {
	if lava_runtime.is_success(result) {
		if len(result.message) > 0 {
			fmt.println(result.message)
		}
		return
	}

	fmt.eprintln(result.message)
}
