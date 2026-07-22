import * as core from "@actions/core";
import { runAction } from "./action";

runAction().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});