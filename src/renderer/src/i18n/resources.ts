// English, the source language: every namespace's catalog, bundled with the
// app. The translations load when they're first shown (see `locales/*.ts`).
// A namespace is a part of the app (`chat`, `publish`…); `common` has what
// many parts say. Add a namespace here and as a JSON file in every language.
import accounts from './locales/en/accounts.json'
import advisor from './locales/en/advisor.json'
import advisorChecks from './locales/en/advisorChecks.json'
import advisorRules from './locales/en/advisorRules.json'
import app from './locales/en/app.json'
import blueprint from './locales/en/blueprint.json'
import chat from './locales/en/chat.json'
import code from './locales/en/code.json'
import common from './locales/en/common.json'
import data from './locales/en/data.json'
import dataModel from './locales/en/dataModel.json'
import gallery from './locales/en/gallery.json'
import git from './locales/en/git.json'
import help from './locales/en/help.json'
import home from './locales/en/home.json'
import mascot from './locales/en/mascot.json'
import mcp from './locales/en/mcp.json'
import migrate from './locales/en/migrate.json'
import models from './locales/en/models.json'
import plan from './locales/en/plan.json'
import preview from './locales/en/preview.json'
import projects from './locales/en/projects.json'
import publish from './locales/en/publish.json'
import secrets from './locales/en/secrets.json'
import security from './locales/en/security.json'
import settings from './locales/en/settings.json'
import setup from './locales/en/setup.json'
import skills from './locales/en/skills.json'
import spotlight from './locales/en/spotlight.json'
import team from './locales/en/team.json'
import teamMap from './locales/en/teamMap.json'
import tools from './locales/en/tools.json'
import workbench from './locales/en/workbench.json'

export const en = {
  accounts,
  advisor,
  advisorChecks,
  advisorRules,
  app,
  blueprint,
  chat,
  code,
  common,
  data,
  dataModel,
  gallery,
  git,
  help,
  home,
  mascot,
  mcp,
  migrate,
  models,
  plan,
  preview,
  projects,
  publish,
  secrets,
  security,
  settings,
  setup,
  skills,
  spotlight,
  team,
  teamMap,
  tools,
  workbench
}

export type Namespace = keyof typeof en

export const NAMESPACES = Object.keys(en) as Namespace[]
