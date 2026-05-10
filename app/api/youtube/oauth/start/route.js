import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";

const STATE_COOKIE = "yt_oauth_state";
const STATE_MAX_AGE = 600;

export async function GET(request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: "YouTube OAuth not configured (GOOGLE_CLIENT_ID, YOUTUBE_OAUTH_REDIRECT_URI)" },
      { status: 500 }
    );
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const cookieStore = await cookies();
  cookieStore.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_MAX_AGE,
  });

  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set(
    "scope",
    "https://www.googleapis.com/auth/youtube.upload"
  );
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  u.searchParams.set("include_granted_scopes", "true");

  if (new URL(request.url).searchParams.get("json") === "1") {
    const origin =
      process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin;
    return NextResponse.json({ url: u.toString(), origin });
  }

  return NextResponse.redirect(u.toString());
}
