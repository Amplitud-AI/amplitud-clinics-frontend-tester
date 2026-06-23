import { UAParser, type IResult } from "ua-parser-js";

const FALLBACK = "Unknown device";

function majorVersion(version: string | undefined): string | undefined {
  if (!version?.trim()) return undefined;
  return version.split(".")[0]?.trim() || undefined;
}

function osLabelFromResult(result: IResult): string {
  return [result.os.name, result.os.version].filter(Boolean).join(" ");
}

function labelFromResult(result: IResult): string {
  const browserLabel = [result.browser.name, majorVersion(result.browser.version)]
    .filter(Boolean)
    .join(" ");
  const osLabel = osLabelFromResult(result);
  const deviceType = result.device.type;

  if (deviceType === "mobile" || deviceType === "tablet") {
    const hardware = [result.device.vendor, result.device.model].filter(Boolean).join(" ");
    const parts = [browserLabel, osLabel, hardware].filter(Boolean);
    return parts.length ? parts.join(" · ") : FALLBACK;
  }

  const parts = [browserLabel, osLabel].filter(Boolean);
  return parts.length ? parts.join(" · ") : FALLBACK;
}

/**
 * R-UA-01…04 from stored auth.sessions.user_agent only.
 * Remote rows rely on this — UA string cannot distinguish Windows 11 from 10
 * (Chromium UA reduction freezes NT 10.0).
 */
export function formatDeviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent?.trim()) return FALLBACK;
  return labelFromResult(new UAParser(userAgent).getResult());
}

/**
 * Enriched label for the current browser tab using User-Agent Client Hints when
 * available (Chrome/Edge: accurate Windows 11, macOS version, device model on mobile).
 * Falls back to UA parsing in Firefox/Safari.
 *
 * @see https://learn.microsoft.com/en-us/microsoft-edge/web-platform/how-to-detect-win11
 * @see https://docs.uaparser.dev/guides/how-to-detect-windows-11-using-javascript.html
 */
export async function resolveLocalDeviceLabel(): Promise<string> {
  const parser = new UAParser();
  const result = await Promise.resolve(parser.getResult().withClientHints());
  return labelFromResult(result);
}
