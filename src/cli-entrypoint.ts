import { reportCliFailure, runCli } from "./cli";

runCli().catch(reportCliFailure);