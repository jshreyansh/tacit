/** Fetching the update manifest through a network that comes and goes. No Electron here, so it can be tested. */

/**
 * Network errors that pass: a VPN or Wi-Fi coming up mid-request
 * (ERR_NETWORK_CHANGED, the most common in the field), a dropped connection,
 * a timeout. A 404 or a bad manifest isn't retried.
 */
export function isPassingNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_IO_SUSPENDED|ERR_CONNECTION_(RESET|CLOSED|ABORTED|TIMED_OUT)|ERR_NAME_NOT_RESOLVED|ERR_TIMED_OUT|timed out after|HTTP 5\d\d/.test(message);
}

const CHECK_RETRY_DELAYS_MS = [2_000, 6_000];

/** The manifest, tried again twice when the network hiccups. */
export async function fetchWithRetries(
  url: string,
  fetch: (url: string) => Promise<string>,
  onRetry: (attempt: number, error: Error) => void,
  delays: readonly number[] = CHECK_RETRY_DELAYS_MS,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url);
    } catch (error) {
      if (attempt >= delays.length || !isPassingNetworkError(error)) throw error;
      onRetry(attempt + 1, error instanceof Error ? error : new Error(String(error)));
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}
