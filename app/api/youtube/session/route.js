import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { unsealRefreshToken } from "../crypto.js";

const REFRESH_COOKIE = "yt_refresh";

export async function GET() {
  const cookieStore = await cookies();
  const sealed = cookieStore.get(REFRESH_COOKIE)?.value;
  let connected = false;
  try {
    connected = !!unsealRefreshToken(sealed);
  } catch {
    connected = false;
  }
  return NextResponse.json({ connected });
}
