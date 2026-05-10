import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { OAuth2Client } from "google-auth-library";
import { sealRefreshToken } from "../../crypto.js";

const STATE_COOKIE = "yt_oauth_state";
const REFRESH_COOKIE = "yt_refresh";

function appBase(request) {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    `${new URL(request.url).origin}`
  );
}

export async function GET(request) {
  const base = appBase(request);
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(
      `${base}/?youtube_error=${encodeURIComponent(oauthError)}`
    );
  }

  const cookieStore = await cookies();
  const expected = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);

  if (!code || !state || !expected || state !== expected) {
    return NextResponse.redirect(`${base}/?youtube_error=invalid_state`);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.redirect(`${base}/?youtube_error=config`);
  }

  const client = new OAuth2Client(clientId, clientSecret, redirectUri);
  let refreshToken;
  try {
    const { tokens } = await client.getToken(code);
    refreshToken = tokens.refresh_token;
  } catch {
    return NextResponse.redirect(`${base}/?youtube_error=token_exchange`);
  }

  if (!refreshToken) {
    return NextResponse.redirect(`${base}/?youtube_error=no_refresh_token`);
  }

  let sealed;
  try {
    sealed = sealRefreshToken(refreshToken);
  } catch {
    return NextResponse.redirect(`${base}/?youtube_error=session_secret`);
  }

  cookieStore.set(REFRESH_COOKIE, sealed, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  return NextResponse.redirect(`${base}/?youtube_connected=1`);
}
