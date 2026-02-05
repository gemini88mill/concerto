# Overview

This document serves to explain the agent swarm that will be in use in this project. The overall mission for the swarm is to produce a PR based on a repo given to the application at the start.

## Agents

### Planner

The planner agent is an agent that looks at the human task and plans how to accomplish the task. It does not code, it does not edit it can only plan how to accomplish the task.

The planning agent has the ability to break down large tasks into smaller tasks in order to facilitate smaller PRs and code changes that the human reviewer can read and approve quickly. If the task is broken down into smaller tasks, the smaller tasks must be created in a way that allows for each of the tasks to be run tested and created in parallel.

Once the plan is ready, the orchestrator (this app) will check constarints and approve or reject the task, if the task is rejected then the orchestrator will give the planner more information as to why it failed and the planner will try again.

The planner hands off the result in a zod friendly json to the Implementor in the format that the implementor wants.

### Implementer

The implementer agent implements the plan that is given. it does no planning, no reviewing, it only implements the plan. it receives a zod friendly json that gives it a task to do,

```json
{
  "task_id": "TASK-123",
  "summary": "Fix background color bug in foo.ts",
  "files_to_change": ["src/foo.ts"],
  "change_type": "bugfix",
  "steps": [
    {
      "file": "src/foo.ts",
      "action": "modify",
      "description": "Replace hardcoded color with theme.background.primary"
    }
  ],
  "constraints": {
    "max_files": 1,
    "no_new_dependencies": true,
    "no_architecture_changes": true
  }
}
```
