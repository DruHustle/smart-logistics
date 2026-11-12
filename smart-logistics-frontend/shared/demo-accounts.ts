/** Public walkthrough credentials for the browser-local sample workspace. */
export interface DemoAccount {
  id: string;
  name: string;
  label: string;
  email: string;
  password: string;
  role: "admin" | "engineer" | "analyst" | "user";
  description: string;
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    id: "1",
    name: "Admin User",
    label: "Admin",
    role: "admin",
    email: "admin@imsop.io",
    password: "admin123",
    description: "Explore operations and administration with sample data",
  },
  {
    id: "2",
    name: "Engineer User",
    label: "Engineer",
    role: "engineer",
    email: "engineer@imsop.io",
    password: "engineer123",
    description: "Explore sample integrations and service health",
  },
  {
    id: "3",
    name: "Analyst User",
    label: "Analyst",
    role: "analyst",
    email: "analyst@imsop.io",
    password: "analyst123",
    description: "Explore shipment analytics with sample data",
  },
  {
    id: "4",
    name: "Demo User",
    label: "Demo",
    role: "user",
    email: "demo@imsop.io",
    password: "demo123",
    description: "Track sample shipments as a workspace user",
  },
];

// Retain previous local sessions and published demo.local credential pairs.
export const DEMO_IDENTITIES: DemoAccount[] = [
  ...DEMO_ACCOUNTS,
  {
    ...DEMO_ACCOUNTS[0],
    id: "5",
    name: "Admin Demo",
    email: "admin@demo.local",
    password: "demo-admin-password",
  },
  {
    ...DEMO_ACCOUNTS[3],
    id: "6",
    name: "Operator Demo",
    label: "Operator",
    email: "operator@demo.local",
    password: "demo-operator-password",
  },
  {
    ...DEMO_ACCOUNTS[2],
    id: "7",
    name: "Analyst Demo",
    email: "analyst@demo.local",
    password: "demo-analyst-password",
  },
  {
    ...DEMO_ACCOUNTS[3],
    id: "8",
    name: "Demo User",
    email: "demo@demo.local",
    password: "demo-password",
  },
];

export function getDemoAccount(label: string) {
  return DEMO_IDENTITIES.find(
    account => account.label.toLowerCase() === label.toLowerCase()
  );
}

export function getAllDemoAccounts() {
  return DEMO_ACCOUNTS;
}

export function isDemoAccount(email: string) {
  return DEMO_IDENTITIES.some(account => account.email === email);
}
