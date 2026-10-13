import jsQR from "jsqr";
import type { AppSettings } from "../ui/phone";

export async function decodeQr(base64: string, mimeType: string): Promise<string> {
  const image = new Image();
  image.src = `data:${mimeType};base64,${base64.replace(/^data:[^,]+,/, "")}`;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Photo could not be opened"));
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("QR scanner is unavailable");
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "attemptBoth" });
  if (result === null || result.data === "") throw new Error("No Quiet Hub QR code found in photo");
  return result.data;
}

export function parseSetupQr(value: string, autoOpenNotifications: boolean): Omit<AppSettings, "invertScroll" | "voiceAutoSend" | "speakAnswers" | "quietWhileWorking"> {
  let payload: URL;
  try {
    payload = new URL(value);
  } catch {
    throw new Error("QR code does not contain a valid address");
  }
  const fragment = new URLSearchParams(payload.hash.replace(/^#/, ""));
  const serverUrl = fragment.get("server") ?? payload.searchParams.get("server") ?? "";
  const token = fragment.get("token") ?? payload.searchParams.get("token") ?? "";
  let server: URL;
  try {
    server = new URL(serverUrl);
  } catch {
    throw new Error("QR code does not contain a Quiet Hub server");
  }
  if (server.protocol !== "http:" && server.protocol !== "https:") throw new Error("Only HTTP/HTTPS servers are allowed");
  if (token === "") throw new Error("QR code has no access token");
  return { serverUrl: server.toString().replace(/\/$/, ""), token, autoOpenNotifications };
}
