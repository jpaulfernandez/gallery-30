/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public base URL of the R2 bucket; see `.env.example`. */
  readonly VITE_R2_PUBLIC_URL?: string;
}
