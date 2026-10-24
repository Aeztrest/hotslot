import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Reports produced by `hotslot scan` / `hotslot simulate` live in the repo's data/ folder.
export default defineConfig({
  plugins: [react()],
  publicDir: "../../data",
});
