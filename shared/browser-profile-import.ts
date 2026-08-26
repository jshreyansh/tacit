export type BrowserProfileImportSource = "chrome";

export interface ImportableBrowserProfile {
  source: BrowserProfileImportSource;
  /** Chrome-owned directory key such as `Default` or `Profile 3`. */
  profileId: string;
  /** User-visible Chrome profile name from Local State. */
  name: string;
}

export interface BrowserProfileImportResult {
  source: BrowserProfileImportSource;
  profileId: string;
  profileName: string;
  importedCookies: number;
  skippedCookies: number;
  failedCookies: number;
}
