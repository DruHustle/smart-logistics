import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";
import type { AuthResponse, User } from "@/lib/auth-types";

const service = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  updateProfile: vi.fn(),
  logout: vi.fn(),
  login: vi.fn(),
  resetPassword: vi.fn(),
  changePassword: vi.fn(),
}));
vi.mock("@/lib/auth-factory", () => ({
  AuthServiceFactory: { getService: () => service },
}));
vi.mock("@/lib/api-auth", () => ({ apiAuthService: service }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

const user: User = {
  id: "review-user",
  email: "review@example.invalid",
  name: "Original profile",
  role: "admin",
};
const nextUser: User = {
  ...user,
  id: "next-user",
  name: "New account",
  role: "user",
};

function deferred() {
  let resolve!: (response: AuthResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AuthResponse>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function remoteSignOut() {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: "imsop:auth-change",
      newValue: JSON.stringify({
        sender: "another-tab",
        id: crypto.randomUUID(),
      }),
    })
  );
}

function Session() {
  const auth = useAuth();
  return (
    <>
      <output aria-label="Session">
        {auth.isLoading ? "loading" : (auth.user?.name ?? "signed out")}
      </output>
      <button
        onClick={() => void auth.updateProfile({ name: "Delayed profile" })}
      >
        Update profile
      </button>
      <button onClick={() => void auth.logout()}>Sign out</button>
      <button
        onClick={() =>
          void auth.login("next@example.invalid", "test-only", "live")
        }
      >
        Sign in next account
      </button>
      <button
        onClick={() => void auth.resetPassword("test-only", "new-test-only")}
      >
        Reset password
      </button>
      <button
        onClick={() => void auth.changePassword("test-only", "new-test-only")}
      >
        Change password
      </button>
      {auth.user?.role === "admin" && <button>Admin tools</button>}
    </>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  service.logout.mockResolvedValue(undefined);
  service.getCurrentUser.mockResolvedValue({ success: true, user });
  service.login.mockResolvedValue({ success: true, user: nextUser });
  service.resetPassword.mockResolvedValue({ success: true });
  service.changePassword.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe("pending authentication responses", () => {
  it.each(["remote sign-out", "expiry"])(
    "does not restore a session from a startup read after %s",
    async boundary => {
      const pending = deferred();
      service.getCurrentUser.mockReturnValue(pending.promise);
      render(
        <AuthProvider>
          <Session />
        </AuthProvider>
      );
      expect(screen.getByLabelText("Session").textContent).toBe("loading");

      act(() => {
        if (boundary === "remote sign-out") remoteSignOut();
        else window.dispatchEvent(new Event("imsop:session-expired"));
      });
      await act(async () => pending.resolve({ success: true, user }));

      expect(screen.getByLabelText("Session").textContent).toBe("signed out");
      expect(screen.queryByRole("button", { name: "Admin tools" })).toBeNull();
    }
  );

  it.each([
    "Sign out",
    "remote sign-out",
    "expiry",
    "Reset password",
    "Change password",
  ])(
    "does not restore a user from a delayed profile response after %s",
    async boundary => {
      const pending = deferred();
      service.updateProfile.mockReturnValue(pending.promise);
      render(
        <AuthProvider>
          <Session />
        </AuthProvider>
      );
      await screen.findByText(user.name);

      fireEvent.click(screen.getByRole("button", { name: "Update profile" }));
      expect(service.updateProfile).toHaveBeenCalledOnce();
      await act(async () => {
        if (boundary === "remote sign-out") remoteSignOut();
        else if (boundary === "expiry")
          window.dispatchEvent(new Event("imsop:session-expired"));
        else fireEvent.click(screen.getByRole("button", { name: boundary }));
      });
      expect(screen.getByLabelText("Session").textContent).toBe("signed out");
      await act(async () =>
        pending.resolve({
          success: true,
          user: { ...user, name: "Delayed profile" },
        })
      );

      expect(screen.getByLabelText("Session").textContent).toBe("signed out");
      expect(screen.queryByRole("button", { name: "Admin tools" })).toBeNull();
    }
  );

  it.each(["success", "failure"])(
    "hydrates a newer sign-in before the old startup %s arrives",
    async result => {
      const pending = deferred();
      service.getCurrentUser.mockReturnValue(pending.promise);
      render(
        <AuthProvider>
          <Session />
        </AuthProvider>
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Sign in next account" })
      );
      await screen.findByText(nextUser.name);
      await act(async () => {
        if (result === "success") pending.resolve({ success: true, user });
        else pending.reject(new Error("Old session unavailable"));
      });
      expect(screen.getByLabelText("Session").textContent).toBe(nextUser.name);
      expect(screen.queryByRole("button", { name: "Admin tools" })).toBeNull();
    }
  );

  it("keeps a newer intentional sign-in when an old profile response arrives", async () => {
    const pending = deferred();
    service.updateProfile.mockReturnValue(pending.promise);
    render(
      <AuthProvider>
        <Session />
      </AuthProvider>
    );
    await screen.findByText(user.name);
    fireEvent.click(screen.getByRole("button", { name: "Update profile" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in next account" })
    );
    await screen.findByText(nextUser.name);
    await act(async () => pending.resolve({ success: true, user }));
    expect(screen.getByLabelText("Session").textContent).toBe(nextUser.name);
    expect(screen.queryByRole("button", { name: "Admin tools" })).toBeNull();
  });

  it("accepts a current profile update and a later intentional sign-in", async () => {
    service.updateProfile.mockResolvedValue({
      success: true,
      user: { ...user, name: "Current profile" },
    });
    render(
      <AuthProvider>
        <Session />
      </AuthProvider>
    );
    await screen.findByText(user.name);
    fireEvent.click(screen.getByRole("button", { name: "Update profile" }));
    await screen.findByText("Current profile");
    expect(screen.getByRole("button", { name: "Admin tools" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    });
    expect(screen.getByLabelText("Session").textContent).toBe("signed out");
    fireEvent.click(
      screen.getByRole("button", { name: "Sign in next account" })
    );
    await screen.findByText(nextUser.name);
  });

  it.each(["Reset password", "Change password"])(
    "does not clear a newer session when an earlier %s request completes",
    async action => {
      const pending = deferred();
      const method =
        action === "Reset password"
          ? service.resetPassword
          : service.changePassword;
      method.mockReturnValue(pending.promise);
      render(
        <AuthProvider>
          <Session />
        </AuthProvider>
      );
      await screen.findByText(user.name);
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(method).toHaveBeenCalledOnce();
      fireEvent.click(
        screen.getByRole("button", { name: "Sign in next account" })
      );
      await screen.findByText(nextUser.name);
      await act(async () => pending.resolve({ success: true }));
      expect(screen.getByLabelText("Session").textContent).toBe(nextUser.name);
      expect(service.logout).not.toHaveBeenCalled();
    }
  );
});
