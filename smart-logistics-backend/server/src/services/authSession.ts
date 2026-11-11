import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { connection } from "../config/db";
import { getJwtSecret } from "../config/security";
import type { users } from "../models/schema";

export const authCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite:
    process.env.NODE_ENV === "production"
      ? ("none" as const)
      : ("lax" as const),
  maxAge: 15 * 60 * 1000,
  path: "/",
});

type SessionUser = Pick<
  typeof users.$inferSelect,
  "id" | "activeWorkspaceId" | "sessionVersion" | "role"
>;
export async function createSession(
  user: SessionUser,
  encryptedOnesaToken: string | null = null,
) {
  const sid = randomUUID();
  await connection.query(
    `INSERT INTO auth_sessions(id,user_id,workspace_id,version,role,onesa_token,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,now()+interval '15 minutes')`,
    [
      sid,
      user.id,
      user.activeWorkspaceId,
      user.sessionVersion,
      user.role,
      encryptedOnesaToken,
    ],
  );
  return jwt.sign({ id: user.id, sid }, getJwtSecret(), {
    expiresIn: "15m",
    issuer: "imsop-api",
    audience: "imsop-web",
  });
}
