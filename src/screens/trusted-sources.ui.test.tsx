/**
 * UI integration tests for the trusted-firmware-source surface.
 *
 * `trusted-sources.integration.test.ts` already proves the lib-level
 * helpers reject http. This file drives the actual screens the user
 * touches so a regression in the wiring (e.g. a future Settings refactor
 * that bypasses `normalisePrefix`, or a Flash pre-flight that starts
 * trusting raw URLs) is caught at the UI seam.
 *
 * We mock the heavy `useScooter` hook and the `ProfilePicker` child so
 * SettingsScreen can render in jsdom without pulling the entire BLE stack.
 * Everything we actually assert on (the trusted-sources Input, toast
 * error, and `listTrustedSources` storage) is exercised for real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { findTrustedSource, addTrustedSource, listTrustedSources } from "@/lib/trusted-sources";

// ─── Mocks ────────────────────────────────────────────────────────────
// SettingsScreen pulls in useScooter (BLE stack) and ProfilePicker
// (paired-profile UI). Neither is relevant to trusted-source validation
// so we replace them with inert stubs.
vi.mock("@/hooks/use-scooter", () => ({
  useScooter: () => ({
    disconnect: vi.fn(),
    selected: null,
    flashLog: [],
    clearLog: vi.fn(),
  }),
  configureHandshakeRetry: vi.fn(),
  handshakeRetryConfig: { enabled: true, backoffMs: 800 },
  resetHandshakeRetry: vi.fn(),
  HANDSHAKE_RETRY_DEFAULTS: { enabled: true, backoffMs: 800 },
}));

vi.mock("@/components/ProfilePicker", () => ({
  ProfilePicker: () => null,
}));

// Capture toast calls so we can assert the exact error message.
const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
  Toaster: () => null,
}));

// Capacitor stubs — Share/Capacitor are pulled in for the Backup button
// but we never click it in these tests.
vi.mock("@capacitor/share", () => ({ Share: { share: vi.fn() } }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));

import { SettingsScreen } from "@/screens/SettingsScreen";

beforeEach(() => {
  localStorage.clear();
  toastError.mockClear();
  toastSuccess.mockClear();
});

// ─── SettingsScreen: trusted-source input ─────────────────────────────
describe("SettingsScreen — trusted-source input rejects http", () => {
  const fillAndAdd = (prefix: string, label = "Evil mirror") => {
    render(<SettingsScreen />);
    // The prefix field is identified by its placeholder copy.
    const prefixInput = screen.getByPlaceholderText(
      /https:\/\/fw\.example\.com or https:\/\/host\/path\//,
    );
    const labelInput = screen.getByPlaceholderText(/Label \(e\.g\./);
    fireEvent.change(labelInput, { target: { value: label } });
    fireEvent.change(prefixInput, { target: { value: prefix } });
    fireEvent.click(screen.getByRole("button", { name: /ADD TRUSTED SOURCE/i }));
  };

  it("shows the 'Enter a valid https:// URL' error for http:// prefixes", () => {
    fillAndAdd("http://fw.example.com/m365/");
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/valid https:\/\//i),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(listTrustedSources()).toEqual([]);
  });

  it("shows the same https-only error for other unsafe schemes", () => {
    fillAndAdd("ftp://fw.example.com/");
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/valid https:\/\//i),
    );
    expect(listTrustedSources()).toEqual([]);
  });

  it("accepts an https prefix and renders it in the trusted list", () => {
    fillAndAdd("https://fw.example.com/m365", "Self-host");
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalled();
    const stored = listTrustedSources();
    expect(stored).toHaveLength(1);
    // normalisePrefix appends the trailing slash on path entries.
    expect(stored[0].prefix).toBe("https://fw.example.com/m365/");
    // And the prefix is rendered in the list panel.
    expect(screen.getByText("https://fw.example.com/m365/")).toBeInTheDocument();
  });

  it("does not surface a previously-added https entry to an http URL", () => {
    // Seed an https trusted entry, then type the same host as http:// — the
    // Add button must still error and storage must be unchanged.
    addTrustedSource("ours", "https://fw.example.com");
    expect(listTrustedSources()).toHaveLength(1);

    fillAndAdd("http://fw.example.com/", "hijack");
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/valid https:\/\//i),
    );
    expect(listTrustedSources()).toHaveLength(1);
    expect(listTrustedSources()[0].prefix).toBe("https://fw.example.com");
  });
});

// ─── FlashScreen pre-flight gate: http URLs never satisfy integrityOk ──
// FlashScreen itself is a ~1.1k-line component with a deep dependency
// graph (catalog query, motion, alert dialogs, BLE store, file picker…)
// so rendering it in jsdom is intractable. We instead test the exact
// predicate it uses on line 188:
//
//   integrityOk = !hashUnverified || unverifiedAck || !!trustedMatch
//   trustedMatch = findTrustedSource(selected.url)
//
// If `findTrustedSource` ever returned a match for an http URL,
// `trustedMatch` would silently flip `integrityOk` true and bypass the
// SHA-256 ack gate. This test pins that down end-to-end against the
// real storage layer.
describe("FlashScreen integrity gate — http URL never auto-trusts", () => {
  beforeEach(() => {
    // Realistic seeding: user trusts their self-hosted https origin.
    addTrustedSource("self-hosted", "https://fw.example.com");
  });

  it("returns no trusted match for an http firmware URL on a trusted host", () => {
    // Same host the user trusted, but downgraded to plaintext — must NOT match.
    expect(findTrustedSource("http://fw.example.com/m365/drv.bin")).toBeNull();
  });

  it("returns no trusted match for an http URL even with a path-prefix entry", () => {
    addTrustedSource("path", "https://fw.example.com/m365");
    expect(findTrustedSource("http://fw.example.com/m365/drv.bin")).toBeNull();
  });

  it("still matches the https equivalent (sanity check)", () => {
    expect(findTrustedSource("https://fw.example.com/m365/drv.bin"))
      .not.toBeNull();
  });
});

// Silence an unused-import warning from `within` if we don't need it.
void within;
