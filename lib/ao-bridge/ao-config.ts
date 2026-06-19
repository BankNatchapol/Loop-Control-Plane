const DEFAULT_AO_API_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_AO_MUX_HOST = "127.0.0.1";
const DEFAULT_AO_MUX_PORT = 14_801;
const DEFAULT_LCP_MUX_PROXY_PORT = 31_101;

export type AoBridgeConfig = {
  apiBaseUrl: string;
  muxHost: string;
  muxPort: number;
  lcpMuxProxyPort: number;
  headless: boolean;
};

const readPositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
};

export const resolveAoBridgeConfig = (): AoBridgeConfig => ({
  apiBaseUrl: (
    process.env.LOOPBOARD_AO_API_BASE_URL ??
    process.env.AO_API_BASE_URL ??
    DEFAULT_AO_API_BASE_URL
  ).replace(/\/$/u, ""),
  muxHost: process.env.LOOPBOARD_AO_MUX_HOST ?? DEFAULT_AO_MUX_HOST,
  muxPort: readPositiveInt(process.env.LOOPBOARD_AO_MUX_PORT, DEFAULT_AO_MUX_PORT),
  lcpMuxProxyPort: readPositiveInt(
    process.env.LOOPBOARD_AO_MUX_PROXY_PORT,
    DEFAULT_LCP_MUX_PROXY_PORT,
  ),
  headless:
    process.env.LOOPBOARD_AO_HEADLESS === "1" ||
    process.env.AO_HEADLESS === "1" ||
    process.env.AO_LOOPBOARD_HEADLESS === "1",
});

export const buildAoMuxUpstreamUrl = (config: AoBridgeConfig = resolveAoBridgeConfig()): string =>
  `ws://${config.muxHost}:${config.muxPort}/mux`;

export const buildLcpMuxProxyUrl = (
  config: AoBridgeConfig = resolveAoBridgeConfig(),
  publicHost = "127.0.0.1",
): string => `ws://${publicHost}:${config.lcpMuxProxyPort}/mux`;
