import type { ReactNode } from "react";

export const metadata = { title: "Reverse Match Copilot" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
