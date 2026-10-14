import { runTrackingPoll } from "../domain/tracking/trackingPoller.js";
import { prisma } from "../prisma/runtime.js";
// One invocation only. No timer, schedule, real adapter, credential lookup or live HTTP implementation.
const controller=new AbortController();
const stop=()=>controller.abort();process.once("SIGTERM",stop);process.once("SIGINT",stop);
try { console.log(JSON.stringify(await runTrackingPoll({signal:controller.signal}))); }
catch { console.error("Tracking poll failed; durable state retained");process.exitCode=1; }
finally {process.removeListener("SIGTERM",stop);process.removeListener("SIGINT",stop);await prisma.$disconnect();}
