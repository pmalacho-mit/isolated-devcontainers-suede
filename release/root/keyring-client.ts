// One request to one of the keyring's sockets.
import { connect } from "node:net";

export const ask = (socketPath: string, request: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const connection = connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error(`the keyring did not answer at ${socketPath} within ${timeoutMs} ms`));
    }, timeoutMs);
    connection.on("connect", () => connection.write(JSON.stringify(request) + "\n"));
    connection.on("data", (chunk) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer);
      connection.end();
      try {
        resolve(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      } catch (error) {
        reject(error as Error);
      }
    });
    connection.on("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`cannot reach ${socketPath}: ${error.message}`), { code: (error as NodeJS.ErrnoException).code }));
    });
  });
