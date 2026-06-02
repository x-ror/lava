#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPORT_DIR=${REPORT_DIR:-"$ROOT_DIR/reports"}
HTML_FILE=${HTML_FILE:-"$REPORT_DIR/node-vs-lava.html"}
TSV_FILE=${TSV_FILE:-"$REPORT_DIR/node-vs-lava.tsv"}
TMP_DIR=${TMPDIR:-/tmp}/lava-node-vs-lava.$$
TIME_BIN=${TIME_BIN:-/usr/bin/time}
NODE_BIN=${NODE_BIN:-node}
LAVA_BIN=${LAVA_BIN:-"$ROOT_DIR/bin/lava"}

mkdir -p "$REPORT_DIR" "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT

html_escape() {
	sed \
		-e 's/&/\&amp;/g' \
		-e 's/</\&lt;/g' \
		-e 's/>/\&gt;/g' \
		-e 's/"/\&quot;/g'
}

measure() {
	name=$1
	shift
	stdout_file=$1
	stderr_file=$2
	time_file=$3
	shift 3

	set +e
	"$TIME_BIN" -f 'elapsed_sec=%e max_rss_kb=%M' -o "$time_file" "$@" >"$stdout_file" 2>"$stderr_file"
	exit_code=$?
	set -e

	elapsed_sec=$(awk '{for (i = 1; i <= NF; i++) if ($i ~ /^elapsed_sec=/) {sub(/^elapsed_sec=/, "", $i); print $i}}' "$time_file")
	max_rss_kb=$(awk '{for (i = 1; i <= NF; i++) if ($i ~ /^max_rss_kb=/) {sub(/^max_rss_kb=/, "", $i); print $i}}' "$time_file")

	printf '%s\t%s\t%s\t%s\n' "$name" "$exit_code" "$elapsed_sec" "$max_rss_kb"
}

snippet() {
	file=$1
	if [ ! -s "$file" ]; then
		printf '%s' ''
		return
	fi
	sed -n '1,8p' "$file" | html_escape
}

"$NODE_BIN" --version >/dev/null
"$LAVA_BIN" --version >/dev/null

printf 'case\tstatus\treason\tnode_exit\tlava_exit\tnode_elapsed_sec\tlava_elapsed_sec\tnode_rss_kb\tlava_rss_kb\tstdout_equal\tstderr_equal\n' >"$TSV_FILE"

rows_file="$TMP_DIR/rows.html"
summary_file="$TMP_DIR/summary"
printf '%s' '' >"$rows_file"
total=0
matched=0
mismatched=0

for case_file in "$ROOT_DIR"/tests/node-compat/cases/*.js "$ROOT_DIR"/tests/node-compat/cases/*.mjs; do
	case_name=${case_file#$ROOT_DIR/}
	case_id=$(basename "$case_file")

	node_stdout="$TMP_DIR/$case_id.node.stdout"
	node_stderr="$TMP_DIR/$case_id.node.stderr"
	node_time="$TMP_DIR/$case_id.node.time"
	lava_stdout="$TMP_DIR/$case_id.lava.stdout"
	lava_stderr="$TMP_DIR/$case_id.lava.stderr"
	lava_time="$TMP_DIR/$case_id.lava.time"

	node_metrics=$(measure node "$node_stdout" "$node_stderr" "$node_time" "$NODE_BIN" "$case_file")
	lava_metrics=$(measure lava "$lava_stdout" "$lava_stderr" "$lava_time" "$LAVA_BIN" run "$case_file")

	node_exit=$(printf '%s\n' "$node_metrics" | cut -f2)
	node_elapsed=$(printf '%s\n' "$node_metrics" | cut -f3)
	node_rss=$(printf '%s\n' "$node_metrics" | cut -f4)
	lava_exit=$(printf '%s\n' "$lava_metrics" | cut -f2)
	lava_elapsed=$(printf '%s\n' "$lava_metrics" | cut -f3)
	lava_rss=$(printf '%s\n' "$lava_metrics" | cut -f4)

	stdout_equal=no
	stderr_equal=no
	if cmp -s "$node_stdout" "$lava_stdout"; then stdout_equal=yes; fi
	if cmp -s "$node_stderr" "$lava_stderr"; then stderr_equal=yes; fi

	status=pass
	reason=match
	if [ "$node_exit" != "$lava_exit" ]; then
		status=fail
		reason=exit
	elif [ "$stdout_equal" != yes ]; then
		status=fail
		reason=stdout
	elif [ "$stderr_equal" != yes ]; then
		status=fail
		reason=stderr
	fi

	total=$((total + 1))
	if [ "$status" = pass ]; then
		matched=$((matched + 1))
	else
		mismatched=$((mismatched + 1))
	fi

	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
		"$case_name" "$status" "$reason" "$node_exit" "$lava_exit" "$node_elapsed" "$lava_elapsed" "$node_rss" "$lava_rss" "$stdout_equal" "$stderr_equal" >>"$TSV_FILE"

	case_html=$(printf '%s' "$case_name" | html_escape)
	node_stderr_html=$(snippet "$node_stderr")
	lava_stderr_html=$(snippet "$lava_stderr")

	cat >>"$rows_file" <<EOF
<tr class="$status">
  <td><code>$case_html</code></td>
  <td><span class="badge $status">$status</span></td>
  <td>$reason</td>
  <td>$node_exit</td>
  <td>$lava_exit</td>
  <td>$node_elapsed</td>
  <td>$lava_elapsed</td>
  <td>$node_rss</td>
  <td>$lava_rss</td>
  <td>$stdout_equal</td>
  <td>$stderr_equal</td>
  <td><details><summary>stderr</summary><div class="stderr"><strong>Node</strong><pre>$node_stderr_html</pre><strong>Lava</strong><pre>$lava_stderr_html</pre></div></details></td>
</tr>
EOF
done

printf '%s\t%s\t%s\n' "$total" "$matched" "$mismatched" >"$summary_file"
node_version=$("$NODE_BIN" --version)
lava_version=$("$LAVA_BIN" --version 2>/dev/null || true)
generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

cat >"$HTML_FILE" <<EOF
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lava Node Compatibility Report</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 32px; background: #f7f8fb; color: #18202a; }
    main { max-width: 1180px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    .meta { color: #5d6978; margin-bottom: 24px; }
    .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 20px 0 24px; }
    .card { background: #fff; border: 1px solid #dde3ea; border-radius: 8px; padding: 16px; }
    .label { color: #607080; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dde3ea; border-radius: 8px; overflow: hidden; }
    th, td { padding: 10px 12px; border-bottom: 1px solid #e7ebf0; text-align: left; vertical-align: top; font-size: 13px; }
    th { background: #eef2f6; color: #334155; font-weight: 650; }
    tr.pass { background: #f4fbf7; }
    tr.fail { background: #fff7f6; }
    code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 12px; }
    .badge { display: inline-block; min-width: 42px; text-align: center; border-radius: 999px; padding: 2px 8px; font-weight: 700; font-size: 12px; }
    .badge.pass { color: #075e35; background: #ccefdc; }
    .badge.fail { color: #8f1f17; background: #ffd8d3; }
    details summary { cursor: pointer; color: #375a7f; }
    pre { white-space: pre-wrap; max-width: 520px; margin: 6px 0 10px; font-size: 12px; }
    @media (prefers-color-scheme: dark) {
      body { background: #101419; color: #e7edf4; }
      .meta { color: #9aa8b6; }
      .card, table { background: #171d24; border-color: #2b3540; }
      th { background: #202935; color: #d9e2ec; }
      th, td { border-color: #2b3540; }
      tr.pass { background: #102018; }
      tr.fail { background: #261514; }
    }
  </style>
</head>
<body>
<main>
  <h1>Node.js vs Lava Compatibility</h1>
  <div class="meta">Generated $generated_at · Node $node_version · Lava $lava_version</div>
  <div class="cards">
    <div class="card"><div class="label">Cases</div><div class="value">$total</div></div>
    <div class="card"><div class="label">Matched</div><div class="value">$matched</div></div>
    <div class="card"><div class="label">Mismatched</div><div class="value">$mismatched</div></div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Case</th>
        <th>Status</th>
        <th>Reason</th>
        <th>Node Exit</th>
        <th>Lava Exit</th>
        <th>Node Time</th>
        <th>Lava Time</th>
        <th>Node RSS KB</th>
        <th>Lava RSS KB</th>
        <th>Stdout</th>
        <th>Stderr</th>
        <th>Details</th>
      </tr>
    </thead>
    <tbody>
$(cat "$rows_file")
    </tbody>
  </table>
</main>
</body>
</html>
EOF

printf 'Node vs Lava HTML report: %s\n' "$HTML_FILE"
printf 'Node vs Lava TSV report:  %s\n' "$TSV_FILE"
printf 'cases=%s matched=%s mismatched=%s\n' "$total" "$matched" "$mismatched"

