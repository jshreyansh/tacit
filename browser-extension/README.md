# Tacit Connected Browser prototype

Load this directory as an unpacked Manifest V3 extension in Chrome, Edge, or Brave. In Tacit, start a browser pairing and paste the displayed `http://127.0.0.1:<port>#<one-time-code>` value into the extension. Then open the extension on the exact tab you want and select **Connect this tab**.

The extension never reads a browser profile directory, exports passwords, or copies cookies. It receives commands only for a tab that was explicitly granted. The local pairing expires after fifteen minutes and creates a revocable install secret.

This is a development prototype. Store packaging, signed extension IDs, reconnection UX, and browser-store distribution remain release work.
