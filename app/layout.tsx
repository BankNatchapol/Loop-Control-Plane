import type { Metadata } from "next";
import { Caveat, Patrick_Hand } from "next/font/google";
import "@xyflow/react/dist/style.css";
import "./globals.css";

const caveat = Caveat({
  subsets: ["latin"],
  variable: "--font-caveat",
  weight: ["400", "500", "600", "700"],
});

const hand = Patrick_Hand({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-hand",
});

export const metadata: Metadata = {
  title: "Loop Control Plane",
  description: "Local AI coding loop execution board prototype",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${caveat.variable} ${hand.variable}`}>
      <body className={hand.className}>{children}</body>
    </html>
  );
}
