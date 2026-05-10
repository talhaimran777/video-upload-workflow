import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { OAuth2Client } from "google-auth-library";
import { unsealRefreshToken } from "../crypto.js";

const REFRESH_COOKIE = "yt_refresh";

export async function POST() {
  const cookieStore = await cookies();
  const sealed = cookieStore.get(REFRESH_COOKIE)?.value;
  const refresh = unsealRefreshToken(sealed);

  if (!refresh) {
    return NextResponse.json({ error: "Not connected to YouTube" }, { status: 401 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.YOUTUBE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return NextResponse.json({ error: "YouTube OAuth not configured" }, { status: 500 });
  }

  const client = new OAuth2Client(clientId, clientSecret, redirectUri);
  client.setCredentials({ refresh_token: refresh });

  try {
    const { credentials } = await client.refreshAccessToken();
    const accessToken = credentials.access_token;
    if (!accessToken) {
      return NextResponse.json({ error: "No access token" }, { status: 500 });
    }
    const expiresIn =
      credentials.expiry_date != null
        ? Math.max(0, Math.floor((credentials.expiry_date - Date.now()) / 1000))
        : credentials.expires_in ?? 3600;

    return NextResponse.json({
      access_token: accessToken,
      expires_in: expiresIn,
    });
  } catch (e) {
    const message =
      e instanceof Error ? e.message : "Failed to refresh access token";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
