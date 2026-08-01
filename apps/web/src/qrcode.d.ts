declare module "qrcode" {
  interface QrCodeDataUrlOptions {
    readonly errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    readonly margin?: number;
    readonly width?: number;
    readonly color?: { readonly dark?: string; readonly light?: string };
  }

  const QRCode: {
    toDataURL(text: string, options?: QrCodeDataUrlOptions): Promise<string>;
  };

  export default QRCode;
}
