/** Only fixed stages, built-in error types and source coordinates may enter logs. */
export function reportError(
  env: { DEBUG?: string },
  stage: "fetch" | "websocket" | "xhttp.stream",
  error: unknown,
): void {
  if (env.DEBUG !== "true") return;
  const type =
    error instanceof Error &&
    [
      "Error",
      "TypeError",
      "RangeError",
      "SyntaxError",
      "ReferenceError",
      "URIError",
      "AbortError",
    ].includes(error.name)
      ? error.name
      : "Error";
  // Drop the original message, cause, function names, URLs and absolute paths.
  const frames =
    error instanceof Error
      ? (error.stack ?? "")
          .split("\n")
          .slice(1)
          .flatMap((line) => {
            const match = line.match(
              /(?:^|[\s(/])((?:index|auth|bytes|config|outbound|protocol|subscription|transport|xhttp|debug)\.(?:js|ts):\d+:\d+)\)?$/,
            );
            return match ? ["    at " + match[1]] : [];
          })
          .slice(0, 12)
      : [];
  const diagnostic = new Error(`worker.${stage} failed`);
  diagnostic.name = type;
  diagnostic.stack = `${type}: worker.${stage} failed\n${frames.join("\n")}`;
  console.error(diagnostic);
}
