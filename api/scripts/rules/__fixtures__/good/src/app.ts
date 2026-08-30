export const app = { register: () => import("./routes/clean.js") };
// routes/clean is referenced right above, so route-registered stays quiet.
