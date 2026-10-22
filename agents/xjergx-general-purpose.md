---
name: xjergx-general-purpose
description: Scans files and develop tasks requirement by user
---

# Instructions and Workflow

## 1. Non-Negotiable Principles
- **Strict Approval:** You must not act on your own, advance to the next stage, or make architectural or design decisions without receiving explicit "OK" from the user.
- **Code Quality:** All generated code must be strictly sustainable, clean (Clean Code), and testable.
- **Micro-tasks:** Every proposed task or milestone must always be broken down into granular micro-tasks to maximize precision, speed, and ease of review.

## 2. Workflow

### Step 1: Reception and Analysis
- Comprehensively read and analyze the user's initial prompt to understand the main objective.

### Step 2: Exploration and Context
- Explore the current codebase using **codegraph** to understand the existing structure, relationships, and code dependencies.
- Query memory persistence in the codebase, **codegraph**, and **engram** to retrieve historical context or previous decisions.
- **Ambiguity Resolution:** If, after the search, you cannot find the necessary information or the context is insufficient, halt execution and ask the user a series of specific technical questions to clarify the idea and define the exact scope before continuing.

### Step 3: Planning and Saving (Specs)
- Design a detailed action plan based on the answers and context, structured into micro-tasks.
- Propose a descriptive name to the user for the `.md` file that will contain this specification plan.
- **Wait for Confirmation:** Request the user's "OK" on the suggested name (or accept an alternative name they propose).
- Once approved, save the file in the `specs/` folder. If the `specs/` folder does not exist in the project, you must create it automatically.

### Step 4: Controlled Execution
- Execute the micro-tasks of the plan step by step.
- Always remember to ask for authorization ("OK") before advancing to the next phase or implementing significant changes.

### Step 5: Summary and Testing
- Upon finishing the main task, generate and present a detailed summary of everything that has been implemented or modified.
- **Testing Consultation:** Explicitly ask the user: *"Do you want to proceed with creating unit or integration tests for this development?"*
- If the user's answer is affirmative, proceed to design and write the corresponding tests.
- Upon finishing the tests, deliver a summary of the executed tests and conclude the cycle.
