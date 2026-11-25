import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithRetries, isPassingNetworkError } from "../electron/update-fetch";

test("a network that changes mid-check is tried again; a missing manifest isn't", async () => {
  const seen: string[] = [];
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw new Error("net::ERR_NETWORK_CHANGED");
    return "version: 1.0.0";
  };
  assert.equal(await fetchWithRetries("u", flaky, (n, e) => seen.push(`${n} ${e.message}`), [0, 0]), "version: 1.0.0");
  assert.deepEqual(seen, ["1 net::ERR_NETWORK_CHANGED", "2 net::ERR_NETWORK_CHANGED"]);

  calls = 0;
  const missing = async () => {
    calls++;
    throw new Error("HTTP 404 from u");
  };
  await assert.rejects(fetchWithRetries("u", missing, () => {}, [0, 0]), /404/);
  assert.equal(calls, 1);

  calls = 0;
  const down = async () => {
    calls++;
    throw new Error("timed out after 20s fetching u");
  };
  await assert.rejects(fetchWithRetries("u", down, () => {}, [0, 0]), /timed out/);
  assert.equal(calls, 3, "three tries in all, then it gives up");
  for (const m of ["net::ERR_INTERNET_DISCONNECTED", "HTTP 503 from u", "net::ERR_CONNECTION_RESET"]) assert.ok(isPassingNetworkError(new Error(m)), m);
  for (const m of ["HTTP 404 from u", "SHA-512 verification failed"]) assert.ok(!isPassingNetworkError(new Error(m)), m);
});
