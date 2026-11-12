import { DEMO_ACCOUNTS, type DemoAccount } from "../../../shared/demo-accounts";
import { useHashQuery } from "@/lib/hash-location";
import { safeSessionStorage } from "@/lib/storage";
import { hostedWorkspace, portalAccount } from "@/lib/portal-account";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrainCircuit, Lock, Mail, Eye, EyeOff } from "lucide-react";
import { apiAuthService } from "@/lib/api-auth";
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { useLocation } from "wouter";

export default function Login() {
  const { login } = useAuth();
  const [, navigate] = useLocation();
  const query = useHashQuery();
  const liveRequested = query.get("mode") === "live";
  const onesaResult = query.get("onesa");
  const [onesaEnabled, setOnesaEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    apiAuthService
      .onesaAvailable()
      .then(enabled => {
        if (active) setOnesaEnabled(enabled);
      })
      .catch(() => {
        if (active) setOnesaEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const [signInMode, setSignInMode] = useState<"live" | "demo">("live");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const linkRequested = onesaEnabled && onesaResult === "link";

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (hostedWorkspace && signInMode === "live") {
      if (linkRequested) await signInWithOnesa(true);
      return;
    }
    setIsLoading(true);

    try {
      const result = await login(email, password, signInMode);
      if (result.success) {
        const destination = safeSessionStorage.getItem("imsop:return-to");
        safeSessionStorage.removeItem("imsop:return-to");
        safeSessionStorage.removeItem("imsop:session-expired");
        navigate(
          destination?.startsWith("#/") &&
            !/^#\/(login|reset-password|forgot-password)/.test(destination)
            ? destination.slice(1)
            : "/"
        );
      } else {
        toast.error(result.error || "Login failed");
      }
    } catch (error) {
      toast.error("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  async function signInWithOnesa(link = false) {
    setIsLoading(true);
    try {
      await apiAuthService.startOnesa(
        link ? { email: email.trim(), password } : undefined
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Onesa sign-in is unavailable."
      );
      setIsLoading(false);
    }
  }

  const fillDemoCredentials = (account: DemoAccount) => {
    setSignInMode("demo");
    setShowPassword(false);
    setEmail(account.email);
    setPassword(account.password);
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-background bg-cover bg-center p-4 relative"
      style={{
        backgroundImage: `url("${import.meta.env.BASE_URL}images/hero-bg.jpg")`,
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-black/50"
      />
      <Card className="w-full max-w-md glass-panel border-border relative z-10 animate-in fade-in zoom-in duration-500">
        {safeSessionStorage.getItem("imsop:session-expired") && (
          <p role="status" className="p-4 text-sm">
            Your session expired. Sign in to return to your work.
          </p>
        )}
        {safeSessionStorage.getItem("imsop:signout-pending") && (
          <p role="alert" className="p-4 text-sm">
            Server sign out was not confirmed. This device is locked locally.
            Signing in retries sign out first.
          </p>
        )}
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded bg-primary flex items-center justify-center ">
              <BrainCircuit className="w-7 h-7 text-primary-foreground" />
            </div>
          </div>
          <h1 className="text-2xl font-semibold">Welcome to Smart Logistics</h1>
          <CardDescription className="text-muted-foreground">
            Intelligent Multi-Cloud Supply Chain & Operations Platform
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <p
            role="status"
            className="text-sm text-center text-muted-foreground"
          >
            {signInMode === "demo"
              ? "Demo sign-in · Example data only"
              : liveRequested
                ? hostedWorkspace
                  ? "Sign in with your Onesa account to view live data."
                  : "Sign in with your workspace account to view live data."
                : "Live access uses your Onesa Company Portal account."}
          </p>
          {signInMode === "demo" && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                setSignInMode("live");
                setEmail("");
                setPassword("");
              }}
            >
              Use live sign-in
            </Button>
          )}
          {onesaResult && (
            <p role="alert" className="text-sm">
              {onesaResult === "link"
                ? "This email already has a Logistics account. Enter its email and password below, then choose Link account with Onesa to confirm both accounts."
                : onesaResult === "denied"
                  ? "Your Onesa account needs approved Logistics access. Administrators must complete MFA."
                  : onesaResult === "unavailable"
                    ? "Onesa sign-in is temporarily unavailable. Please try again."
                    : "This sign-in has expired. Please start again."}
            </p>
          )}
          {(hostedWorkspace || onesaEnabled) && signInMode === "live" && (
            <Button
              variant="outline"
              className="w-full"
              disabled={isLoading}
              onClick={() => void signInWithOnesa()}
            >
              Sign in with Onesa
            </Button>
          )}
          {hostedWorkspace &&
            onesaEnabled === false &&
            signInMode === "live" && (
              <p role="status">
                The shared sign-in service is not connected. You can retry or
                manage your account in Company Portal.
              </p>
            )}
          {(!hostedWorkspace || signInMode === "demo" || linkRequested) && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="email"
                    readOnly={hostedWorkspace && signInMode === "demo"}
                    type="email"
                    autoComplete="email"
                    placeholder="Enter your email"
                    value={email}
                    onChange={e => {
                      if (hostedWorkspace && signInMode === "demo") return;
                      if (signInMode === "demo") setPassword("");
                      setEmail(e.target.value);
                      setSignInMode("live");
                    }}
                    className="pl-10 bg-background/50 border-border"
                    required
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <button
                    type="button"
                    onClick={() =>
                      hostedWorkspace
                        ? window.location.assign(portalAccount + "/security")
                        : navigate("/forgot-password")
                    }
                    className="text-xs text-primary hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="password"
                    readOnly={hostedWorkspace && signInMode === "demo"}
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className="h-11 pl-10 pr-12 bg-background/50 border-border"
                    required
                  />
                  <button
                    type="button"
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full bg-primary hover:bg-primary/80 text-primary-foreground "
              >
                {isLoading
                  ? "Signing in..."
                  : hostedWorkspace && linkRequested && signInMode === "live"
                    ? "Link account with Onesa"
                    : "Sign In"}
              </Button>
              {!hostedWorkspace &&
                onesaEnabled &&
                signInMode === "live" &&
                onesaResult === "link" && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    disabled={isLoading || !email || !password}
                    onClick={() => void signInWithOnesa(true)}
                  >
                    Link account with Onesa
                  </Button>
                )}
            </form>
          )}

          <div className="text-center text-sm">
            <span className="text-muted-foreground">
              Don't have an account?{" "}
            </span>
            <button
              onClick={() =>
                hostedWorkspace
                  ? window.location.assign(portalAccount + "/register")
                  : navigate("/register")
              }
              className="text-primary hover:underline font-semibold"
            >
              Sign Up
            </button>
          </div>

          <details
            open={!liveRequested}
            className="rounded-md border border-border p-3"
          >
            <summary className="cursor-pointer text-sm font-semibold">
              Demo accounts
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">
              Choose a role to fill the sign-in form. Each account uses sample
              logistics data.
            </p>
            <div
              role="group"
              aria-label="Demo accounts"
              className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"
            >
              {DEMO_ACCOUNTS.map(account => (
                <Button
                  key={account.id}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-h-11 px-2 text-xs"
                  title={account.description}
                  aria-pressed={
                    signInMode === "demo" && email === account.email
                  }
                  disabled={isLoading}
                  onClick={() => fillDemoCredentials(account)}
                >
                  {account.label}
                </Button>
              ))}
            </div>
          </details>

          <div className="mt-6 text-center text-xs text-muted-foreground">
            <p>Account access through Onesa Company Portal</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
