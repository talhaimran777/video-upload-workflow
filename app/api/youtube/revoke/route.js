import { NextResponse } from "next/server";
import { cookies } from "next/headers";

const REFRESH_COOKIE = "yt_refresh";

export async function POST() {
  const cookieStore = await cookies();
  cookieStore.delete(REFRESH_COOKIE);
  return NextResponse.json({ ok: true });
}
