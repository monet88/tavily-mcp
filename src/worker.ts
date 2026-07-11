// Task 7 owns the real Worker. Temporary placeholder so wrangler main exists.
export { TavilyCoordinator } from "./coordinator.js";

export default {
  fetch(): Response {
    return new Response("Worker not implemented", { status: 501 });
  },
};
