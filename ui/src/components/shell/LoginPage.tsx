import { useState } from "react";
import { CircleAlert } from "lucide-react";
import { api } from "../../api/client";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Form";
import { BrandLogo } from "./Sidebar";

export function LoginPage({ passwordSet, onLogin }: { passwordSet: boolean; onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api.login(username, password);
      onLogin();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="brand">
          <BrandLogo />
          <span className="brand-name">Promethea</span>
        </div>
        <div className="col" style={{ gap: 6 }}>
          <h1>Sign in</h1>
          <p>
            {passwordSet
              ? "Use the Web UI account set in Promethea's settings."
              : "Remote access is turned on, but no password has been set yet. Set one in Settings → Web UI on the computer running Promethea."}
          </p>
        </div>
        {passwordSet && (
          <>
            <Field label="Username">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
                required
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
          </>
        )}
        {error && (
          <div className="callout error" role="alert">
            <CircleAlert />
            <span>{error}</span>
          </div>
        )}
        {passwordSet && (
          <Button type="submit" variant="primary" loading={busy}>
            Sign in
          </Button>
        )}
      </form>
    </div>
  );
}
