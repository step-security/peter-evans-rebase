import * as core from '@actions/core'
import * as io from '@actions/io'
import * as inputHelper from 'checkout/lib/input-helper'
import {GitCommandManager} from './git-command-manager'
import * as gitSourceProvider from 'checkout/lib/git-source-provider'
import * as inputValidator from './input-validator'
import {PullsHelper} from './pulls-helper'
import {RebaseHelper} from './rebase-helper'
import {inspect} from 'util'
import {v4 as uuidv4} from 'uuid'
import * as utils from './utils'
import fs from 'fs'
import axios, {isAxiosError} from 'axios'

async function validateSubscription() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  let repoPrivate: boolean | undefined

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    repoPrivate = eventData?.repository?.private
  }

  const upstream = 'peter-evans/rebase'
  const action = process.env.GITHUB_ACTION_REPOSITORY
  const docsUrl =
    'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions'

  core.info('')
  core.info('\u001b[1;36mStepSecurity Maintained Action\u001b[0m')
  core.info(`Secure drop-in replacement for ${upstream}`)
  if (repoPrivate === false)
    core.info('\u001b[32m\u2713 Free for public repositories\u001b[0m')
  core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`)
  core.info('')

  if (repoPrivate === false) return

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const body: Record<string, string> = {action: action || ''}
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      {timeout: 3000}
    )
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`
      )
      core.error(
        `\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`
      )
      process.exit(1)
    }
    core.info('Timeout or API not reachable. Continuing to next step.')
  }
}

async function run(): Promise<void> {
  try {
    await validateSubscription()
    const inputs = {
      token: core.getInput('token'),
      repository: core.getInput('repository'),
      head: core.getInput('head'),
      base: core.getInput('base'),
      includeLabels: utils.getInputAsArray('include-labels'),
      excludeLabels: utils.getInputAsArray('exclude-labels'),
      excludeDrafts: core.getInput('exclude-drafts') === 'true',
      rebaseOptions: utils.getInputAsArray('rebase-options')
    }
    core.debug(`Inputs: ${inspect(inputs)}`)

    const [headOwner, head] = inputValidator.parseHead(inputs.head)

    const pullsHelper = new PullsHelper(inputs.token)
    const pulls = await pullsHelper.get(
      inputs.repository,
      head,
      headOwner,
      inputs.base,
      inputs.includeLabels,
      inputs.excludeLabels,
      inputs.excludeDrafts
    )

    if (pulls.length > 0) {
      core.info(`${pulls.length} pull request(s) found.`)

      // Checkout
      const path = uuidv4()
      process.env['INPUT_PATH'] = path
      process.env['INPUT_FETCH-DEPTH'] = '0'
      process.env['INPUT_PERSIST-CREDENTIALS'] = 'true'
      const sourceSettings = await inputHelper.getInputs()
      core.debug(`sourceSettings: ${inspect(sourceSettings)}`)
      await gitSourceProvider.getSource(sourceSettings)

      // Rebase
      // Create a git command manager
      const git = await GitCommandManager.create(sourceSettings.repositoryPath)
      const rebaseHelper = new RebaseHelper(git, inputs.rebaseOptions)
      let rebasedCount = 0
      for (const pull of pulls) {
        const result = await rebaseHelper.rebase(pull)
        if (result) rebasedCount++
      }

      // Output count of successful rebases
      core.setOutput('rebased-count', rebasedCount)

      // Delete the repository
      core.debug(`Removing repo at '${sourceSettings.repositoryPath}'`)
      await io.rmRF(sourceSettings.repositoryPath)
    } else {
      core.info('No pull requests found.')
    }
  } catch (error) {
    core.setFailed(utils.getErrorMessage(error))
  }
}

run()
