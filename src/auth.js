const crypto = require("node:crypto");
const { User, UserSession } = require("./models");
const { isDatabaseConnected } = require("./database");

const COOKIE_NAME = "theorika_session";
const TOKEN_LIFETIME_SECONDS = 6 * 60 * 60;

function getAuthSecret() {
  const secret = process.env.AUTH_TOKEN_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_TOKEN_SECRET must contain at least 32 characters.");
  }
  return secret;
}

function signToken(payload) {
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const body = encodeJson(payload);
  const unsigned = `${header}.${body}`;
  const signature = crypto.createHmac("sha256", getAuthSecret()).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function verifyToken(token) {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = segments;
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256" || header.typ !== "JWT" || payload.iss !== "theorika-api" || payload.aud !== "theorika-web") {
    return null;
  }
  const expected = crypto.createHmac("sha256", getAuthSecret()).update(`${headerPart}.${payloadPart}`).digest();
  let received;
  try {
    received = Buffer.from(signaturePart, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000) || typeof payload.sub !== "string" || typeof payload.jti !== "string") {
    return null;
  }
  return payload;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function tokenFromRequest(request) {
  const cookies = request.headers.cookie?.split(";") || [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === COOKIE_NAME) {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    }
  }
  return null;
}

function setSessionCookie(response, token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const sameSite = process.env.NODE_ENV === "production" ? "None" : "Lax";
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAge}${secure}`,
  );
}

function clearSessionCookie(response) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const sameSite = process.env.NODE_ENV === "production" ? "None" : "Lax";
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=0${secure}`);
}

async function createSession(user, request, response) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((now + TOKEN_LIFETIME_SECONDS) * 1000);
  const tokenId = crypto.randomUUID();
  const tokenIdHash = crypto.createHash("sha256").update(tokenId).digest("hex");
  await UserSession.create({
    user: user._id,
    tokenIdHash,
    device: request.get("user-agent")?.slice(0, 300),
    ipAddress: request.ip?.slice(0, 80),
    expiresAt,
  });
  const token = signToken({ iss: "theorika-api", aud: "theorika-web", sub: String(user._id), jti: tokenId, iat: now, exp: now + TOKEN_LIFETIME_SECONDS });
  setSessionCookie(response, token, expiresAt);
}

function requireAuth({ roles, permission } = {}) {
  return async (request, response, next) => {
    try {
      if (!isDatabaseConnected()) {
        return response.status(503).json({ error: "Portal services are temporarily unavailable because the database is not connected." });
      }
      const token = tokenFromRequest(request);
      const claims = token && verifyToken(token);
      if (!claims) return response.status(401).json({ error: "Please sign in to continue." });
      const tokenIdHash = crypto.createHash("sha256").update(claims.jti).digest("hex");
      const session = await UserSession.findOne({
        user: claims.sub,
        tokenIdHash,
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      }).select("+tokenIdHash").lean();
      if (!session) return response.status(401).json({ error: "This session has ended. Please sign in again." });
      const user = await User.findById(claims.sub).lean();
      if (!user || user.status !== "active" || user.deletedAt || !user.permissions?.canLogin) {
        await UserSession.updateOne({ _id: session._id }, { $set: { revokedAt: new Date() } });
        clearSessionCookie(response);
        return response.status(403).json({ error: "This account is not currently allowed to sign in." });
      }
      if (roles && !roles.includes(user.role)) return response.status(403).json({ error: "You do not have access to this area." });
      if (permission && !user.permissions?.[permission] && user.role !== "superadmin") {
        return response.status(403).json({ error: "Your account does not have permission to perform this action." });
      }
      request.auth = { user, sessionId: session._id };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function getSessionToken(request) {
  const token = tokenFromRequest(request);
  return token ? verifyToken(token) : null;
}

module.exports = {
  COOKIE_NAME,
  TOKEN_LIFETIME_SECONDS,
  clearSessionCookie,
  createSession,
  getAuthSecret,
  getSessionToken,
  requireAuth,
};
