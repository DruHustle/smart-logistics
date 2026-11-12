import { DEMO_IDENTITIES } from "../../../shared/demo-accounts";
import { safeLocalStorage } from "./storage";
import { User, AuthResponse, IAuthService } from "./auth-types";

const SESSION_KEY = "imsop_session",
  TOKEN_KEY = "imsop_token";
export class MockAuthService implements IAuthService {
  async login(email: string, password: string): Promise<AuthResponse> {
    await new Promise(r => setTimeout(r, 500));
    const user = DEMO_IDENTITIES.find(
      u => u.email === email && u.password === password
    );
    if (!user) return { success: false, error: "Invalid email or password" };
    const { id, name, email: accountEmail, role } = user;
    const userWithoutPassword: User = { id, name, email: accountEmail, role };
    safeLocalStorage.setItem(TOKEN_KEY, `mock_${btoa(email)}`);
    safeLocalStorage.setItem(SESSION_KEY, JSON.stringify(userWithoutPassword));
    return { success: true, user: userWithoutPassword };
  }
  logout = () =>
    [TOKEN_KEY, SESSION_KEY].forEach(k => safeLocalStorage.removeItem(k));
  async getCurrentUser(): Promise<AuthResponse> {
    try {
      const user = JSON.parse(safeLocalStorage.getItem(SESSION_KEY) || "null");
      const account = DEMO_IDENTITIES.find(
        u =>
          u.id === user?.id && u.email === user?.email && u.role === user?.role
      );
      if (!account || typeof user.name !== "string") {
        this.logout();
        return { success: false };
      }
      return { success: true, user };
    } catch {
      this.logout();
      return { success: false };
    }
  }
  register = async () => ({
    success: false,
    error: "Cannot register with a demo email domain.",
  });
  requestPasswordReset = async (email: string) => ({
    success: true,
    token: `mock_reset_${btoa(email)}`,
  });
  resetPassword = async () => ({ success: true });
  async updateProfile(
    userId: string,
    updates: Partial<Pick<User, "name" | "avatar">>
  ): Promise<AuthResponse> {
    const user = JSON.parse(safeLocalStorage.getItem(SESSION_KEY) || "null");
    if (!user) return { success: false, error: "Not authenticated" };
    const updated = { ...user, ...updates };
    safeLocalStorage.setItem(SESSION_KEY, JSON.stringify(updated));
    return { success: true, user: updated };
  }
  changePassword = async (
    _id: string,
    current: string,
    _next: string
  ): Promise<AuthResponse> => {
    const session = JSON.parse(safeLocalStorage.getItem(SESSION_KEY) || "null");
    const account = DEMO_IDENTITIES.find(u => u.email === session?.email);
    return account?.password === current
      ? { success: true }
      : { success: false, error: "Current demo password is incorrect" };
  };
}
export const mockAuthService = new MockAuthService();
