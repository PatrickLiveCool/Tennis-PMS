import { randomInt } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";

// Generated local test identifiers only: never send calls or SMS to these numbers.
// Atomic reservations avoid reuse across these scripts, concurrent runs and retries.
export function reserveSyntheticPhone() {
  const directory = ".local-workspace/browser-customer-phones";
  mkdirSync(directory, { recursive: true });
  for (;;) {
    const phone = `139${String(randomInt(100_000_000)).padStart(8, "0")}`;
    try {
      closeSync(openSync(`${directory}/${phone}`, "wx", 0o600));
      return phone;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
}
