export const sweepTimes=new Map<string,number>();
export function completedSweep(name:string){sweepTimes.set(name,Date.now());}
export function sweepAge(name:string,now=Date.now()){return Math.max(0,(now-(sweepTimes.get(name)??started))/1000);}
const started=Date.now();
