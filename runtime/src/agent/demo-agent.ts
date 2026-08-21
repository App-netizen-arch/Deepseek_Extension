/**
 * Demo agent: the "Hello World" of the agent system.
 *
 * Used to exercise the full lifecycle (spawn -> start -> plan -> execute ->
 * complete) without touching external systems. The execution hook emits a
 * structured log line "Hello, I am agent <name>" and returns the same
 * message as its result.
 */
import { log } from "../operational.js";
import { assertNotAborted, Agent, type AgentDescriptor, type AgentPlan, type AgentTaskView } from "./agent.js";

export const DEMO_AGENT_TYPE = "demo";

/** Minimal agent that greets and completes. */
export class DemoAgent extends Agent {
  /** @inheritdoc */
  protected async doPlan(task: AgentTaskView): Promise<AgentPlan> {
    return {
      summary: `Greet once as "${this.name}"`,
      steps: [`emit greeting for task ${task.id}`],
    };
  }

  /** @inheritdoc */
  protected async doExecute(task: AgentTaskView): Promise<unknown> {
    assertNotAborted(this);
    const message = `Hello, I am agent ${this.name}`;
    log("info", "agent hello", { agentId: this.id, taskId: task.id, type: this.type, message });
    return { message, taskId: task.id };
  }
}

/**
 * Factory that maps a registered agent type to a concrete Agent instance.
 * New agent types plug in by wrapping or replacing this function.
 */
export type AgentFactory = (descriptor: AgentDescriptor) => Agent;

export function createDefaultFactory(): AgentFactory {
  const constructors = new Map<string, new (descriptor: AgentDescriptor) => Agent>();
  constructors.set(DEMO_AGENT_TYPE, DemoAgent);
  return (descriptor) => {
    const Ctor = constructors.get(descriptor.type);
    if (!Ctor) throw new Error(`unsupported agent type: ${descriptor.type}`);
    return new Ctor(descriptor);
  };
}
