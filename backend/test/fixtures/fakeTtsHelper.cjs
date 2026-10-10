// A stand-in for tts_server.py: prints ready, then answers each request line.
// A request whose voice is "fail" gets an error; "hang" is never answered; "die" exits the process.
process.stdout.write(JSON.stringify({ ready: true }) + "\n");
let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.voice === "hang") continue;
    if (request.voice === "die") process.exit(3);
    const reply = request.voice === "fail" ? { id: request.id, ok: false, error: "boom" } : { id: request.id, ok: true };
    process.stdout.write(JSON.stringify(reply) + "\n");
  }
});
