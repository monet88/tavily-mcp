export { TavilyCoordinator } from "../../src/coordinator.js";

export default {
  fetch(): Response {
    return new Response("Coordinator test entry", { status: 404 });
  },
};
