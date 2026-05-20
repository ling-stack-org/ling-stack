export interface DaemonConfig {
  readonly host: string;
  readonly port: number;
}

export const defaultDaemonConfig: DaemonConfig = {
  host: "127.0.0.1",
  port: 17891,
};
