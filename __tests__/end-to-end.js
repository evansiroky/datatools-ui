// @flow

import path from 'path'

import fs from 'fs-extra'
import fetch from 'isomorphic-fetch'
import {safeLoad} from 'js-yaml'
import md5File from 'md5-file/promise'
import moment from 'moment'
import puppeteer from 'puppeteer'
import SimpleNodeLogger from 'simple-node-logger'

import {collectingCoverage, isCi} from './test-utils/utils'

// TODO: Allow the below options (puppeteer and test) to be enabled via command
// line options parsed by mastarm.
const puppeteerOptions = {
  headless: isCi,
  // The following options can be enabled manually to help with debugging.
  // dumpio: true, // Logs all of browser console to stdout
  // slowMo: 30 // puts xx milliseconds between events (for easier watching in non-headless)
  // NOTE: In order to run on Travis CI, use args --no-sandbox option
  args: isCi ? ['--no-sandbox'] : []
}
const testOptions = {
  // If enabled, failFast will break out of the test script immediately.
  failFast: false
}
let failingFast = false
let successfullyCreatedTestProject = false
let config: {
  password: string,
  username: string
}
let browser
let page
const gtfsUploadFile = './configurations/end-to-end/test-gtfs-to-upload.zip'
const OTP_ROOT = 'http://localhost:8080/otp/routers/'
const testTime = moment().format()
const testProjectName = `test-project-${testTime}`
const testFeedSourceName = `test-feed-source-${testTime}`
const dummyStop1 = {
  code: '1',
  description: 'test 1',
  id: 'test-stop-1',
  lat: '37.04671717',
  lon: '-122.07529759',
  name: 'Laurel Dr and Valley Dr',
  url: 'example.stop/1'
}
const dummyStop2 = {
  code: '2',
  description: 'test 2',
  id: 'test-stop-2',
  lat: '37.04783038',
  lon: '-122.07521176',
  name: 'Russell Ave and Valley Dr',
  url: 'example.stop/2'
}
let testProjectId
let feedSourceId
let scratchFeedSourceId
let routerId
const log = SimpleNodeLogger.createSimpleFileLogger(`e2e-run-${testTime}.log`)
const browserEventLogs = SimpleNodeLogger.createSimpleFileLogger(`e2e-run-${testTime}-browser-events.log`)
const testResults = {}
const defaultTestTimeout = 100000
const defaultJobTimeout = 100000

function makeMakeTest (defaultDependentTests: Array<string> | string = []) {
  if (!(defaultDependentTests instanceof Array)) {
    defaultDependentTests = [defaultDependentTests]
  }
  return (
    name: string,
    fn: Function,
    timeout?: number,
    dependentTests: Array<string> | string = []
  ) => {
    test(name, async () => {
      log.info(`Begin test: "${name}"`)
      if (failingFast) {
        log.error('Failing fast due to previous failed test')
        throw new Error('Failing fast due to previous failed test')
      }

      // first make sure all dependent tests have passed
      if (!(dependentTests instanceof Array)) {
        dependentTests = [dependentTests]
      }
      dependentTests = [...defaultDependentTests, ...dependentTests]

      dependentTests.forEach(test => {
        if (!testResults[test]) {
          log.error(`Dependent test "${test}" has not completed yet`)
          throw new Error(`Dependent test "${test}" has not completed yet`)
        }
      })

      // do actual test
      try {
        await fn()
      } catch (e) {
        log.error(`test "${name}" failed due to error: ${e}`)

        // Take screenshot of page to help debugging.
        await page.screenshot({
          path: `e2e-error-${name.replace(' ', '_')}-${testTime}.png`,
          fullPage: true
        })

        // report coverage thus far
        await sendCoverageToServer()

        // fail fast if needed
        if (testOptions.failFast) {
          log.info('Fail fast option enabled. Failing remaining tests.')
          // Delay by a second so that log statement is processed.
          failingFast = true
        }
        throw e
      }

      // report coverage thus far
      await sendCoverageToServer()

      // note successful completion
      testResults[name] = true
      log.info(`successful test: "${name}"`)
    }, timeout)
  }
}

const makeTest = makeMakeTest()
const makeTestPostLogin = makeMakeTest('should login')
const makeTestPostFeedSource = makeMakeTest(['should login', 'should create feed source'])
const makeEditorEntityTest = makeMakeTest([
  'should login',
  'should create feed source',
  'should edit a feed from scratch'
])

// this can be turned off in development mode to skip some tests that do not
// need to be run in order for other tests to work properly
const doNonEssentialSteps = true

/**
 * Collect current coverage and send it to coverage collector server
 */
async function sendCoverageToServer () {
  if (collectingCoverage) {
    const coverage = await page.evaluate(() => window.__coverage__)

    await fetch('http://localhost:9999/coverage/client', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(coverage)
    })
  }
}

async function expectSelectorToContainHtml (selector: string, html: string) {
  const innerHTML = await getInnerHTMLFromSelector(selector)
  expect(innerHTML).toContain(html)
}

async function expectSelectorToNotContainHtml (selector: string, html: string) {
  const innerHTML = await getInnerHTMLFromSelector(selector)
  expect(innerHTML).not.toContain(html)
}

/**
 * Create a new project.  Assumes that this is called while the browser is on
 * the home page.
 */
async function createProject (projectName: string) {
  log.info(`creating project with name: ${projectName}`)
  await click('#context-dropdown')
  await waitForAndClick('a[href="/project/new"]')
  await waitForSelector('[data-test-id="project-name-input-container"]')
  await type('[data-test-id="project-name-input-container"] input', projectName)
  await click('[data-test-id="project-settings-form-save-button"]')
  log.info('saving new project')
  await wait(2000, 'for project to get saved')

  // verify that the project was created with the proper name
  await expectSelectorToContainHtml('.project-header', projectName)

  // go back to project list
  await goto('http://localhost:9966/project', {waitUntil: 'networkidle0'})

  // verify the new project is listed in the project list
  await expectSelectorToContainHtml('[data-test-id="project-list-table"]', projectName)
  log.info(`confirmed successful creation of project with name: ${projectName}`)
}

async function deleteProject (projectId: string) {
  log.info(`deleting project with id: ${projectId}`)
  // navigate to that project's settings
  await goto(`http://localhost:9966/project/${projectId}/settings`)

  // delete that project
  await waitForAndClick('[data-test-id="delete-project-button"]')
  await wait(500, 'for modal to appear')
  await waitForAndClick('[data-test-id="modal-confirm-ok-button"]')
  log.info('deleted project')

  // verify deletion
  await goto(`http://localhost:9966/project/${projectId}`)
  await waitForSelector('.project-not-found')
  await expectSelectorToContainHtml('.project-not-found', projectId)
  log.info(`confirmed successful deletion of project with id ${projectId}`)
}

async function uploadGtfs () {
  log.info('uploading gtfs')
  // create new feed version by clicking on dropdown and upload link
  await click('#bg-nested-dropdown')
  // TODO replace with more specific selector
  await waitForSelector('[data-test-id="upload-feed-button"]')
  await click('[data-test-id="upload-feed-button"]')

  // set file to upload in modal dialog
  // TODO replace with more specific selector
  await waitForSelector('.modal-body input')
  const uploadInput = await page.$('.modal-body input')
  if (!uploadInput) throw new Error('Could not find upload input')
  await uploadInput.uploadFile(gtfsUploadFile)

  // confirm file upload
  // TODO replace with more specific selector
  const footerButtons = await getAllElements('.modal-footer button')
  await footerButtons[0].click()

  await waitAndClearCompletedJobs()
  log.info('completed gtfs upload')
}

/**
 * Fill out create feed source form, save feed source, verify creation and also
 * that it is presnt in the list of project feed sources.
 */
async function createFeedSourceViaForm (feedSourceName) {
  // wait for form to be visible
  await waitForSelector('[data-test-id="feed-source-name-input-container"]')

  // enter feed source name
  await type(
    '[data-test-id="feed-source-name-input-container"] input',
    feedSourceName
  )

  // save and wait
  await click('[data-test-id="create-feed-source-button"]')
  await wait(2000, 'for feed source to be created and saved')

  // verify that feed source was created
  await waitForSelector('.manager-header')
  await expectSelectorToContainHtml('.manager-header', feedSourceName)

  // goto feed source's project page
  await click('[data-test-id="feed-project-link"]')

  // verify that the feed source is listed in project feed sources
  await waitForSelector('#project-viewer-tabs')
  await expectSelectorToContainHtml('#project-viewer-tabs', feedSourceName)

  log.info(`Successfully created Feed Source with name: ${feedSourceName}`)
}

async function createFeedSourceViaProjectHeaderButton (feedSourceName) {
  log.info(`create Feed Source with name: ${feedSourceName} via project header button`)
  // go to project page
  await goto(
    `http://localhost:9966/project/${testProjectId}`,
    {
      waitUntil: 'networkidle0'
    }
  )
  await waitForSelector('[data-test-id="project-header-create-new-feed-source-button"]')
  await click('[data-test-id="project-header-create-new-feed-source-button"]')
  await createFeedSourceViaForm(feedSourceName)
}

async function createStop ({
  code,
  description,
  id,
  lat,
  locationType = '0',
  lon,
  name,
  timezone = { initalText: 'america/lo', option: 1 },
  url,
  wheelchairBoarding = '1',
  zoneId = '1'
}: {
  code: string,
  description: string,
  id: string,
  lat: string,
  locationType?: string, // make optional due to https://github.com/facebook/flow/issues/183
  lon: string,
  name: string,
  timezone?: { // make optional due to https://github.com/facebook/flow/issues/183
    initalText: string,
    option: number
  },
  url: string,
  wheelchairBoarding?: string, // make optional due to https://github.com/facebook/flow/issues/183
  zoneId?: string // make optional due to https://github.com/facebook/flow/issues/183
}) {
  log.info(`creating stop with name: ${name}`)
  // right click on map to create stop
  await page.mouse.click(700, 200, { button: 'right' })

  // wait for entity details sidebar to appear
  await waitForSelector('[data-test-id="stop-stop_id-input-container"]')
  await wait(2000, 'for initial data to load')

  // fill out form

  // set stop_id
  await clearAndType(
    '[data-test-id="stop-stop_id-input-container"] input',
    id
  )

  // code
  await type(
    '[data-test-id="stop-stop_code-input-container"] input',
    code
  )

  // set stop name
  await clearAndType(
    '[data-test-id="stop-stop_name-input-container"] input',
    name
  )

  // description
  await type(
    '[data-test-id="stop-stop_desc-input-container"] input',
    description
  )

  // lat
  await clearAndType(
    '[data-test-id="stop-stop_lat-input-container"] input',
    lat
  )

  // lon
  await clearAndType(
    '[data-test-id="stop-stop_lon-input-container"] input',
    lon
  )

  // zone
  const zoneIdSelector = '[data-test-id="stop-zone_id-input-container"]'
  await click(
    `${zoneIdSelector} .Select-control`
  )
  await type(`${zoneIdSelector} input`, zoneId)
  await page.keyboard.press('Enter')

  // stop url
  await type(
    '[data-test-id="stop-stop_url-input-container"]',
    url
  )

  // stop location type
  await page.select(
    '[data-test-id="stop-location_type-input-container"] select',
    locationType
  )

  // timezone
  await reactSelectOption(
    '[data-test-id="stop-stop_timezone-input-container"]',
    timezone.initalText,
    timezone.option
  )

  // wheelchair boarding
  await page.select(
    '[data-test-id="stop-wheelchair_boarding-input-container"] select',
    wheelchairBoarding
  )

  // save
  await click('[data-test-id="save-entity-button"]')
  await wait(2000, 'for save to happen')
  log.info(`created stop with name: ${name}`)
}

async function clearInput (inputSelector: string) {
  await page.$eval(
    inputSelector,
    input => {
      if (!input) {
        throw new Error(`Could not find input with selector: ${inputSelector}`)
      }
      // make flow happy cause flow-typed page.$eval doesn't get specifc enough
      const _input = (input: any)
      _input.value = ''
    }
  )
}

async function pickColor (containerSelector: string, color: string) {
  await click(`${containerSelector} button`)
  await waitForSelector(`${containerSelector} .sketch-picker`)
  await clearAndType(`${containerSelector} input`, color)
}

async function reactSelectOption (
  containerSelector: string,
  initalText: string,
  optionToSelect: number,
  virtualized: boolean = false
) {
  log.info(`selecting option from react-select container: ${containerSelector}`)
  await click(`${containerSelector} .Select-control`)
  await type(`${containerSelector} input`, initalText)
  const optionSelector =
    `.${virtualized ? 'VirtualizedSelectOption' : 'Select-option'}:nth-child(${optionToSelect})`
  await waitForSelector(optionSelector)
  await click(optionSelector)
  log.info('selected option')
}

function formatSecondsElapsed (startTime: number) {
  return `${(new Date() - startTime) / 1000} seconds`
}

async function waitAndClearCompletedJobs () {
  const startTime = new Date()
  // wait for jobs to get completed
  await wait(500, 'for job monitoring to begin')
  // wait for an active job to appear
  await waitForSelector('[data-test-id="possibly-active-jobs"]')
  // All jobs completed span will appear when all jobs are done.
  await waitForSelector(
    '[data-test-id="all-jobs-completed"]',
    {timeout: defaultJobTimeout}
  )
  await waitForSelector('[data-test-id="clear-completed-jobs-button"]')
  // Clear retired jobs to remove all jobs completed span.
  await click('[data-test-id="clear-completed-jobs-button"]')
  log.info(`cleared completed jobs in ${formatSecondsElapsed(startTime)}`)
}

async function clearAndType (selector: string, text: string) {
  await clearInput(selector)
  await type(selector, text)
}

async function appendText (selector: string, text: string) {
  await page.focus(selector)
  await page.keyboard.press('End')
  await page.keyboard.type(text)
}

async function waitForSelector (selector: string, options?: any) {
  const startTime = new Date()
  await wait(100, 'delay before looking for selector...')
  log.info(`waiting for selector: ${selector}`)
  await page.waitForSelector(selector, options)
  log.info(`selector ${selector} took ${formatSecondsElapsed(startTime)}`)
}

async function click (selector: string) {
  log.info(`clicking selector: ${selector}`)
  await page.click(selector) // , {delay: 3})
}

async function waitForAndClick (selector: string, waitOptions?: any) {
  await waitForSelector(selector, waitOptions)
  await click(selector)
}

async function wait (milliseconds: number, reason?: string) {
  log.info(`waiting ${milliseconds} ms${reason ? ` ${reason}` : ''}...`)
  await page.waitFor(milliseconds)
}

async function goto (url: string, options?: any) {
  // before navigating away from the page, collect and report coverage thus far
  await sendCoverageToServer()

  log.info(`navigating to: ${url}`)
  await page.goto(url, options)
  await wait(1000, 'for page to load')
}

function stripReactTags (str: any): any {
  return str.replace(/<!--[\s\w-:/]*-->/g, '')
}

// There was a weird error of not being able to dynamically get the attribute,
// so the following 2 functions look very similar
async function getHref (element: any) {
  log.info(`getting href for element: ${element}`)
  const href = await page.evaluate(
    el => {
      const _el = (el: any)
      // make flow happy cause flow-typed page.$eval doesn't get specifc enough
      return _el.href
    },
    element
  )
  return href
}

async function getInnerHTML (element: any) {
  log.info(`getting innerHTML for element: ${element}`)
  const html = await page.evaluate(
    el => {
      const _el = (el: any)
      // make flow happy cause flow-typed page.$eval doesn't get specifc enough
      return _el.innerHTML
    },
    element
  )
  return stripReactTags(html)
}

async function getInnerHTMLFromSelector (selector: string) {
  log.info(`getting innerHTML for selector: ${selector}`)
  const html = (await page.$eval(selector, el => {
    const _el = (el: any)
    // make flow happy cause flow-typed page.$eval doesn't get specifc enough
    return _el.innerHTML
  }): any)
  return stripReactTags(html)
}

async function getAllElements (selector: string) {
  log.info(`getting all elements for selector: ${selector}`)
  const elements = await page.$$(selector)
  if (!elements || elements.length === 0) {
    throw new Error(`Could not find any elements for selector: ${selector}`)
  }
  return elements
}

async function type (selector: string, text: string) {
  log.info(`typing text: "${text}" into selector: ${selector}`)
  await page.type(selector, text)
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Start of test suite
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

describe('end-to-end', () => {
  beforeAll(async () => {
    config = (safeLoad(fs.readFileSync('configurations/end-to-end/env.yml')): any)

    // Ping the otp endpoint to ensure the server is running.
    try {
      log.info(`Pinging OTP at ${OTP_ROOT}`)
      await fetch(`${OTP_ROOT}`)
      log.info('OTP is OK.')
      // if (response.status !== 200) throw new Error('OTP not ready!')
      // else log.info('OTP is OK.')
    } catch (e) {
      if (testOptions.failFast) {
        log.error('OpenTripPlanner not accepting requests. Failing remaining tests due to fail fast option.')
        failingFast = true
      } else log.warn('OpenTripPlanner not accepting requests. Start it up for deployment tests!!')
    }
    log.info('Launching chromium for testing...')
    browser = await puppeteer.launch(puppeteerOptions)
    page = await browser.newPage()

    // log certain events happening in the browser
    page.on('console', msg => { browserEventLogs.info(msg.text()) })
    page.on('error', error => {
      browserEventLogs.error(error)
      browserEventLogs.error(error.stack)
    })
    page.on('pageerror', error => { browserEventLogs.error(`Page Error: ${error}`) })
    page.on('requestfailed', req => {
      browserEventLogs.error(`Request failed: ${req.method()} ${req.url()}`)
    })
    page.on('requestfinished', req => {
      browserEventLogs.info(`Request finished: ${req.method()} ${req.url()}`)
    })

    // set the default download behavior to download files to the cwd
    page._client.send(
      'Page.setDownloadBehavior',
      { behavior: 'allow', downloadPath: './' }
    )

    log.info('Setup complete.')
  }, 120000)

  afterAll(async () => {
    // delete test project
    if (successfullyCreatedTestProject) {
      try {
        await deleteProject(testProjectId)
        log.info('Successfully deleted test project. Closing Chromium...')
      } catch (e) {
        log.error(`could not delete project with id "${testProjectId}" due to error: ${e}`)
      }
    }
    // close browser
    await page.close()
    await browser.close()
    log.info('Chromium closed.')
  }, 120000)

  // ---------------------------------------------------------------------------
  // Begin tests
  // ---------------------------------------------------------------------------

  makeTest('should load the page', async () => {
    await goto('http://localhost:9966')
    await waitForSelector('h1')
    await expectSelectorToContainHtml('h1', 'Conveyal Data Tools')
    testResults['should load the page'] = true
  })

  makeTest('should login', async () => {
    await goto('http://localhost:9966', { waitUntil: 'networkidle0' })
    await waitForAndClick('[data-test-id="header-log-in-button"]')
    await waitForSelector('button[class="auth0-lock-submit"]', { visible: true })
    await waitForSelector('input[class="auth0-lock-input"][name="email"]')
    await type('input[class="auth0-lock-input"][name="email"]', config.username)
    await type('input[class="auth0-lock-input"][name="password"]', config.password)
    await click('button[class="auth0-lock-submit"]')
    await waitForSelector('#context-dropdown')
    await wait(2000, 'for projects to load')
  }, defaultTestTimeout, 'should load the page')


  // ---------------------------------------------------------------------------
  // Project tests
  // ---------------------------------------------------------------------------

  describe('project', () => {
    makeTestPostLogin('should create a project', async () => {
      await createProject(testProjectName)

      // go into the project page and verify that it looks ok-ish
      const projectEls = await getAllElements('.project-name-editable a')

      let projectFound = false
      for (const projectEl of projectEls) {
        const innerHtml = await getInnerHTML(projectEl)
        if (innerHtml.indexOf(testProjectName) > -1) {
          const href = await getHref(projectEl)
          testProjectId = href.match(/\/project\/([\w-]*)/)[1]
          await projectEl.click()
          projectFound = true
          break
        }
      }
      if (!projectFound) throw new Error('Created project not found')

      await waitForSelector('#project-viewer-tabs')
      await expectSelectorToContainHtml('#project-viewer-tabs', 'What is a feed source?')
      successfullyCreatedTestProject = true
    }, defaultTestTimeout)

    makeTestPostLogin('should update a project by adding a otp server', async () => {
      // open settings tab
      await waitForAndClick('#project-viewer-tabs-tab-settings')

      // navigate to deployments
      await waitForAndClick('[data-test-id="deployment-settings-link"]', { visible: true })
      // add a server
      await waitForAndClick('[data-test-id="add-server-button"]')
      await waitForSelector('input[name="otpServers.$index.name"]')
      await type('input[name="otpServers.$index.name"]', 'test-otp-server')
      await type('input[name="otpServers.$index.publicUrl"]', 'http://localhost:8080')
      await type('input[name="otpServers.$index.internalUrl"]', 'http://localhost:8080/otp')
      await click('[data-test-id="save-settings-button"]')

      // reload page an verify test server persists
      await page.reload({ waitUntil: 'networkidle0' })
      await expectSelectorToContainHtml('#project-viewer-tabs', 'test-otp-server')
    }, defaultTestTimeout, 'should create a project')

    if (doNonEssentialSteps) {
      makeTestPostLogin('should delete a project', async () => {
        const testProjectToDeleteName = `test-project-that-will-get-deleted-${testTime}`

        // navigate to home project view
        await goto(
          `http://localhost:9966/home/${testProjectId}`,
          {
            waitUntil: 'networkidle0'
          }
        )
        await waitForSelector('#context-dropdown')

        // create a new project
        await createProject(testProjectToDeleteName)

        // get the created project id
        // go into the project page and verify that it looks ok-ish
        const projectEls = await getAllElements('.project-name-editable a')

        let projectFound = false
        let projectToDeleteId = ''
        for (const projectEl of projectEls) {
          const innerHtml = await getInnerHTML(projectEl)
          if (innerHtml.indexOf(testProjectToDeleteName) > -1) {
            const href = await getHref(projectEl)
            projectToDeleteId = href.match(/\/project\/([\w-]*)/)[1]
            projectFound = true
            break
          }
        }
        if (!projectFound) throw new Error('Created project not found')

        await deleteProject(projectToDeleteId)
      }, defaultTestTimeout, 'should create a project')
    }
  })

  // ---------------------------------------------------------------------------
  // Feed Source tests
  // ---------------------------------------------------------------------------

  describe('feed source', () => {
    makeTestPostLogin('should create feed source', async () => {
      // go to project page
      await goto(
        `http://localhost:9966/project/${testProjectId}`,
        {
          waitUntil: 'networkidle0'
        }
      )
      await waitForAndClick('[data-test-id="create-first-feed-source-button"]')
      await createFeedSourceViaForm(testFeedSourceName)

      // find feed source id
      // enter into feed source
      const feedSourceEls = await getAllElements('h4 a')
      let feedSourceFound = false
      feedSourceId = ''
      for (const feedSourceEl of feedSourceEls) {
        const innerHtml = await getInnerHTML(feedSourceEl)
        if (innerHtml.indexOf(testFeedSourceName) > -1) {
          const href = await getHref(feedSourceEl)
          feedSourceId = href.match(/\/feed\/([\w-]*)/)[1]
          feedSourceFound = true
          await feedSourceEl.click()
          break
        }
      }
      if (!feedSourceFound) throw new Error('Created feedSource not found')

      await waitForSelector('#feed-source-viewer-tabs')
      await wait(4000, 'for feed versions to load')
      expectSelectorToContainHtml(
        '#feed-source-viewer-tabs',
        'No versions exist for this feed source.'
      )
    }, defaultTestTimeout, 'should create a project')

    makeTestPostFeedSource('should process uploaded gtfs', async () => {
      await uploadGtfs()

      // wait for main tab to show up with version validity info
      await waitForSelector('[data-test-id="feed-version-validity"]')

      // verify feed was uploaded
      await expectSelectorToContainHtml(
        '[data-test-id="feed-version-validity"]',
        'Valid from Jan. 01, 2014 to Dec. 31, 2018'
      )
    }, defaultTestTimeout)

    // this test also sets the feed source as deployable
    makeTestPostFeedSource('should process fetched gtfs', async () => {
      // navigate to feed source settings
      await click('#feed-source-viewer-tabs-tab-settings')

      // make feed source deployable
      await waitForAndClick(
        '[data-test-id="make-feed-source-deployable-button"]',
        { visible: true }
      )
      // set fetch url
      await type(
        '[data-test-id="feed-source-url-input-group"] input',
        'https://github.com/catalogueglobal/datatools-ui/raw/dev/configurations/end-to-end/test-gtfs-to-fetch.zip'
      )
      await click('[data-test-id="feed-source-url-input-group"] button')
      await wait(2000, 'for feed source to update')

      // go back to feed source GTFS tab
      await click('#feed-source-viewer-tabs-tab-')
      // Open dropdown
      await waitForAndClick(
        '#bg-nested-dropdown',
        { visible: true }
      )
      // create new version by fetching
      await waitForAndClick(
        '[data-test-id="fetch-feed-button"]',
        { visible: true }
      )

      // wait for gtfs to be fetched and processed
      await waitAndClearCompletedJobs()

      // verify that feed was fetched and processed
      await expectSelectorToContainHtml(
        '[data-test-id="feed-version-validity"]',
        'Valid from Apr. 08, 2018 to Jun. 30, 2018'
      )
    }, defaultTestTimeout)

    if (doNonEssentialSteps) {
      makeTestPostFeedSource('should delete feed source', async () => {
        const testFeedSourceToDeleteName = `test-feed-source-to-delete-${testTime}`

        // create a new feed source to delete
        await createFeedSourceViaProjectHeaderButton(testFeedSourceToDeleteName)

        // find created feed source
        const listItemEls = await getAllElements('.list-group-item')
        let feedSourceFound = false
        // cast to any to avoid flow errors
        for (const listItemEl: any of listItemEls) {
          const feedSourceNameEl = await listItemEl.$('h4 a')
          const innerHtml = await getInnerHTML(feedSourceNameEl)
          if (innerHtml.indexOf(testFeedSourceToDeleteName) > -1) {
            // hover over container to display FeedSourceDropdown
            // I tried to use the puppeteer hover method, but that didn't trigger
            // a mouseEnter event.  I needed to simulate the mouse being outside
            // the element and then moving inside
            const listItemBBox = await listItemEl.boundingBox()
            await page.mouse.move(
              listItemBBox.x - 10,
              listItemBBox.y
            )
            await page.mouse.move(
              listItemBBox.x + listItemBBox.width / 2,
              listItemBBox.y + listItemBBox.height / 2
            )
            // click dropdown and delete menu item button
            await waitForAndClick('#feed-source-action-button')
            await waitForAndClick('[data-test-id="feed-source-dropdown-delete-feed-source-button"]')

            // confirm action in modal
            await waitForAndClick('[data-test-id="modal-confirm-ok-button"]')
            await wait(2000, 'for data to refresh')
            feedSourceFound = true
            break
          }
        }
        if (!feedSourceFound) throw new Error('Created feedSource not found')

        // verify deletion
        const feedSourceEls = await getAllElements('h4 a')
        let deletedFeedSourceFound = false
        for (const feedSourceEl of feedSourceEls) {
          const innerHtml = await getInnerHTML(feedSourceEl)
          if (innerHtml.indexOf(testFeedSourceToDeleteName) > -1) {
            deletedFeedSourceFound = true
            break
          }
        }
        if (deletedFeedSourceFound) throw new Error('Feed source did not get deleted!')
      }, defaultTestTimeout)
    }
  })

  // ---------------------------------------------------------------------------
  // Feed Version tests
  // ---------------------------------------------------------------------------

  describe('feed version', () => {
    makeTestPostFeedSource('should download a feed version', async () => {
      await goto(`http://localhost:9966/feed/${feedSourceId}`)
      // Select previous version
      await waitForAndClick('[data-test-id="decrement-feed-version-button"]')
      await wait(2000, 'for previous version to be active')
      // Download version
      await click('[data-test-id="download-feed-version-button"]')
      await wait(5000, 'for file to download')

      // file should get saved to the current root directory, go looking for it
      // verify that file exists
      const downloadsDir = './'
      const files = await fs.readdir(downloadsDir)
      let feedVersionDownloadFile = ''
      // assume that this file will be the only one matching the feed source ID
      for (const file of files) {
        if (file.indexOf(feedSourceId.replace(/:/g, '')) > -1) {
          feedVersionDownloadFile = file
          break
        }
      }
      if (!feedVersionDownloadFile) {
        throw new Error('Feed Version gtfs file not found in Downloads folder!')
      }

      // verify that file has same hash as gtfs file that was uploaded
      const filePath = path.join(downloadsDir, feedVersionDownloadFile)
      expect(await md5File(filePath)).toEqual(await md5File(gtfsUploadFile))

      // delete file
      await fs.remove(filePath)
    }, defaultTestTimeout)

    if (doNonEssentialSteps) {
      // this uploads a feed source again because we want to end up with 2
      // feed versions after this test takes place
      makeTestPostFeedSource('should delete a feed version', async () => {
        // browse to feed source page
        await goto(`http://localhost:9966/feed/${feedSourceId}`)
        // for whatever reason, waitUntil: networkidle0 was not working with the
        // above goto, so wait for a few seconds here
        await wait(5000, 'additional time for page to load')
        // upload gtfs
        await uploadGtfs()
        // click delete button
        await waitForAndClick('[data-test-id="delete-feed-version-button"]')
        // confirm action in modal
        await waitForAndClick('[data-test-id="modal-confirm-ok-button"]')
        await wait(2000, 'for data to refresh')
        await waitForSelector('#feed-source-viewer-tabs')
        // verify that the previous feed is now the displayed feed
        await expectSelectorToContainHtml(
          '[data-test-id="feed-version-validity"]',
          'Valid from Apr. 08, 2018 to Jun. 30, 2018'
        )
      }, defaultTestTimeout)
    }
  })

  // ---------------------------------------------------------------------------
  // Editor tests
  // ---------------------------------------------------------------------------

  describe('editor', () => {
    makeTestPostFeedSource('should load a feed version into the editor', async () => {
      // click edit feed button
      await click('[data-test-id="edit-feed-version-button"]')

      // wait for editor to get ready and show starting dialog
      await waitForAndClick('[data-test-id="import-latest-version-button"]')
      // wait for snapshot to get created
      waitAndClearCompletedJobs()

      // begin editing
      await waitForAndClick('[data-test-id="begin-editing-button"]')
      await wait(2000, 'for dialog to close')
    }, defaultTestTimeout)

    // prepare a new feed source to use the editor from scratch
    makeTestPostFeedSource('should edit a feed from scratch', async () => {
      // browse to feed source page
      const feedSourceName = `feed-source-to-edit-from-scratch-${testTime}`
      await createFeedSourceViaProjectHeaderButton(feedSourceName)

      // find created feed source
      const listItemEls = await getAllElements('.list-group-item')
      let feedSourceFound = false
      for (const listItemEl: any of listItemEls) {
        const feedSourceNameEl = await listItemEl.$('h4 a')
        const innerHtml = await getInnerHTML(feedSourceNameEl)
        if (innerHtml.indexOf(feedSourceName) > -1) {
          feedSourceFound = true
          const href = await getHref(feedSourceNameEl)
          scratchFeedSourceId = href.match(/\/feed\/([\w-]*)/)[1]
          await feedSourceNameEl.click()
          // apparently the first click does not work entirely, it may trigger
          // a load of the FeedSourceDropdown, but the event for clicking the link
          // needs a second try I guess
          await feedSourceNameEl.click()
          break
        }
      }
      if (!feedSourceFound) throw new Error('Created feedSource not found')

      // wait for navigation to feed source
      await waitForSelector('#feed-source-viewer-tabs')
      await wait(2000, 'for feed versions to load')

      // click edit feed button
      await click('[data-test-id="edit-feed-version-button"]')

      // wait for editor to get ready and show starting dialog
      await waitForAndClick('[data-test-id="edit-from-scratch-button"]')
      // wait for snapshot to get created
      waitAndClearCompletedJobs()

      // begin editing
      await waitForAndClick('[data-test-id="begin-editing-button"]')
      await wait(2000, 'for welcome dialog to close')
    }, defaultTestTimeout)

    // ---------------------------------------------------------------------------
    // Feed Info tests
    // ---------------------------------------------------------------------------
    // all of the following editor tests assume the use of the scratch feed
    describe('feed info', () => {
      makeEditorEntityTest('should create feed info data', async () => {
        // open feed info sidebar
        await click('[data-test-id="editor-feedinfo-nav-button"]')

        // wait for feed info sidebar form to appear
        await waitForSelector('#feed_publisher_name')

        // fill out form
        await type('#feed_publisher_name', 'end-to-end automated test')
        await type('#feed_publisher_url', 'example.test')
        await reactSelectOption(
          '[data-test-id="feedinfo-feed_lang-input-container"]',
          'eng',
          2
        )
        await clearAndType(
          '[data-test-id="feedinfo-feed_start_date-input-container"] input',
          '05/29/18'
        )
        await clearAndType(
          '[data-test-id="feedinfo-feed_end_date-input-container"] input',
          '05/29/38'
        )
        await pickColor(
          '[data-test-id="feedinfo-default_route_color-input-container"]',
          '3D65E2'
        )
        await page.select(
          '[data-test-id="feedinfo-default_route_type-input-container"] select',
          '6'
        )
        await type(
          '[data-test-id="feedinfo-feed_version-input-container"] input',
          testTime
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for feed info sidebar form to appear
        await waitForSelector('#feed_publisher_name')

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="feedinfo-feed_publisher_name-input-container"]',
          'end-to-end automated test'
        )
      }, defaultTestTimeout)

      makeEditorEntityTest('should update feed info data', async () => {
        // update publisher name by appending to end
        await appendText('#feed_publisher_name', ' runner')

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for feed info sidebar form to appear
        await waitForSelector('#feed_publisher_name')

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="feedinfo-feed_publisher_name-input-container"]',
          'end-to-end automated test runner'
        )
      }, defaultTestTimeout, 'should create feed info data')
    })

    // ---------------------------------------------------------------------------
    // Agency tests
    // ---------------------------------------------------------------------------
    // all of the following editor tests assume the use of the scratch feed
    describe('agencies', () => {
      makeEditorEntityTest('should create agency', async () => {
        // open agency sidebar
        await click('[data-test-id="editor-agency-nav-button"]')

        // wait for agency sidebar form to appear and click to create agency
        await waitForAndClick('[data-test-id="create-first-agency-button"]')
        // wait for entity details sidebar to appear
        await waitForSelector('[data-test-id="agency-agency_id-input-container"]')

        // fill out form
        await type(
          '[data-test-id="agency-agency_id-input-container"] input',
          'test-agency-id'
        )
        await type(
          '[data-test-id="agency-agency_name-input-container"] input',
          'test agency name'
        )
        await type(
          '[data-test-id="agency-agency_url-input-container"] input',
          'example.test'
        )
        await reactSelectOption(
          '[data-test-id="agency-agency_timezone-input-container"]',
          'america/lo',
          1
        )
        // the below doesn't save the language unless chrome debugger is on.
        // Don't know why, spent way too much time trying to figure out.
        await reactSelectOption(
          '[data-test-id="agency-agency_lang-input-container"]',
          'eng',
          2
        )
        await type(
          '[data-test-id="agency-agency_phone-input-container"] input',
          '555-555-5555'
        )
        await type(
          '[data-test-id="agency-agency_fare_url-input-container"] input',
          'example.fare.test'
        )
        await type(
          '[data-test-id="agency-agency_email-input-container"] input',
          'test@example.com'
        )
        await type(
          '[data-test-id="agency-agency_branding_url-input-container"] input',
          'example.branding.url'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for agency sidebar form to appear
        await waitForSelector(
          '[data-test-id="agency-agency_id-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="agency-agency_id-input-container"]',
          'test-agency-id'
        )
      }, defaultTestTimeout)

      makeEditorEntityTest('should update agency data', async () => {
        // update agency name by appending to end
        await appendText(
          '[data-test-id="agency-agency_name-input-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for agency sidebar form to appear
        await waitForSelector(
          '[data-test-id="agency-agency_name-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="agency-agency_name-input-container"]',
          'test agency name updated'
        )
      }, defaultTestTimeout, 'should create agency')

      makeEditorEntityTest('should delete agency data', async () => {
        // create a new agency that will get deleted
        await click('[data-test-id="clone-agency-button"]')

        // update agency id by appending to end
        await appendText(
          '[data-test-id="agency-agency_id-input-container"] input',
          '-copied'
        )

        // update agency name
        await appendText(
          '[data-test-id="agency-agency_name-input-container"] input',
          ' to delete'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for agency sidebar form to appear
        await waitForSelector(
          '[data-test-id="agency-agency_name-input-container"] input'
        )

        // verify that agency to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'test agency name updated to delete'
        )

        // delete the agency
        await click('[data-test-id="delete-agency-button"]')
        await waitForAndClick('[data-test-id="modal-confirm-ok-button"]')
        await wait(2000, 'for delete to happen')

        // verify that agency to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'test agency name updated to delete'
        )
      }, defaultTestTimeout)
    })

    // ---------------------------------------------------------------------------
    // Route tests
    // ---------------------------------------------------------------------------
    // all of the following editor tests assume the use of the scratch feed and
    // successful completion of the agencies test suite
    describe('routes', () => {
      makeEditorEntityTest('should create route', async () => {
        // open routes sidebar
        await click('[data-test-id="editor-route-nav-button"]')

        // wait for route sidebar form to appear and click button to open form
        // to create route
        await waitForAndClick('[data-test-id="create-first-route-button"]')
        // wait for entity details sidebar to appear
        await waitForSelector('[data-test-id="route-route_id-input-container"]')

        // fill out form
        // set status to approved
        await page.select(
          '[data-test-id="route-status-input-container"] select',
          '2'
        )

        // set public to yes
        await page.select(
          '[data-test-id="route-publicly_visible-input-container"] select',
          '1'
        )

        // set route_id
        await clearAndType(
          '[data-test-id="route-route_id-input-container"] input',
          'test-route-id'
        )

        // set route short name
        await clearAndType(
          '[data-test-id="route-route_short_name-input-container"] input',
          'test1'
        )

        // long name
        await type(
          '[data-test-id="route-route_long_name-input-container"] input',
          'test route 1'
        )

        // description
        await type(
          '[data-test-id="route-route_desc-input-container"] input',
          'test route 1 description'
        )

        // route type
        await page.select(
          '[data-test-id="route-route_type-input-container"] select',
          '3'
        )

        // route color
        await pickColor(
          '[data-test-id="route-route_color-input-container"]',
          '1cff32'
        )

        // route text color
        await page.select(
          '[data-test-id="route-route_text_color-input-container"] select',
          '000000'
        )

        // wheelchair accessible
        await page.select(
          '[data-test-id="route-wheelchair_accessible-input-container"] select',
          '1'
        )

        // branding url
        await type(
          '[data-test-id="route-route_branding_url-input-container"] input',
          'example.branding.test'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for routes sidebar form to appear
        await waitForSelector(
          '[data-test-id="route-route_id-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="route-route_id-input-container"]',
          'test-route-id'
        )
      }, defaultTestTimeout, 'should create agency')

      makeEditorEntityTest('should update route data', async () => {
        // update route name by appending to end
        await appendText(
          '[data-test-id="route-route_long_name-input-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for routes sidebar form to appear
        await waitForSelector(
          '[data-test-id="route-route_long_name-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="route-route_long_name-input-container"]',
          'test route 1 updated'
        )
      }, defaultTestTimeout, ['should create agency', 'should create route'])

      makeEditorEntityTest('should delete route data', async () => {
        // create a new route that will get deleted
        await click('[data-test-id="clone-route-button"]')

        // update route id by appending to end
        await appendText(
          '[data-test-id="route-route_id-input-container"] input',
          '-copied'
        )

        // update route name
        await appendText(
          '[data-test-id="route-route_long_name-input-container"] input',
          ' to delete'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for routes sidebar form to appear
        await waitForSelector(
          '[data-test-id="route-route_long_name-input-container"] input'
        )

        // verify that route to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'test route 1 updated to delete'
        )

        // delete the route
        await click('[data-test-id="delete-route-button"]')
        await waitForAndClick('[data-test-id="modal-confirm-ok-button"]')
        await wait(2000, 'for delete to happen')

        // verify that route to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'test route 1 updated to delete'
        )
      }, defaultTestTimeout, 'should create agency')
    })

    // ---------------------------------------------------------------------------
    // Stops tests
    // ---------------------------------------------------------------------------
    // all of the following editor tests assume the use of the scratch feed
    describe('stops', () => {
      makeEditorEntityTest('should create stop', async () => {
        // open stop info sidebar
        await click('[data-test-id="editor-stop-nav-button"]')

        // wait for stop sidebar form to appear
        await waitForSelector('[data-test-id="create-stop-instructions"]')

        await createStop(dummyStop1)

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for feed info sidebar form to appear
        await waitForSelector(
          '[data-test-id="stop-stop_id-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="stop-stop_id-input-container"]',
          'test-stop-1'
        )
      }, defaultTestTimeout)

      makeEditorEntityTest('should update stop data', async () => {
        // create a 2nd stop
        await createStop(dummyStop2)

        // update stop name by appending to end
        await appendText(
          '[data-test-id="stop-stop_desc-input-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for feed info sidebar form to appear
        await waitForSelector(
          '[data-test-id="stop-stop_desc-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="stop-stop_desc-input-container"]',
          'test 2 updated'
        )
      }, defaultTestTimeout)

      makeEditorEntityTest('should delete stop data', async () => {
        // create a new stop that will get deleted
        await click('[data-test-id="clone-stop-button"]')

        // update stop id by appending to end
        await appendText(
          '[data-test-id="stop-stop_id-input-container"] input',
          '-copied'
        )

        // update stop code
        await clearAndType(
          '[data-test-id="stop-stop_code-input-container"] input',
          '3'
        )

        // update stop name
        await appendText(
          '[data-test-id="stop-stop_name-input-container"] input',
          ' to delete'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for feed info sidebar form to appear
        await waitForSelector(
          '[data-test-id="stop-stop_name-input-container"] input'
        )

        // verify that stop to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'Russell Ave and Valley Dr to delete (3)'
        )

        // delete the stop
        await click('[data-test-id="delete-stop-button"]')
        await waitForAndClick('[data-test-id="modal-confirm-ok-button"]')
        await wait(2000, 'for delete to happen')

        // verify that stop to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'Russell Ave and Valley Dr to delete (3)'
        )
      }, defaultTestTimeout, 'should create stop')
    })

    // ---------------------------------------------------------------------------
    // Calenadar tests
    // ---------------------------------------------------------------------------
    // all of the following editor tests assume the use of the scratch feed
    describe('calendars', () => {
      makeEditorEntityTest('should create calendar', async () => {
        // open calendar sidebar
        await click('[data-test-id="editor-calendar-nav-button"]')

        // wait for calendar sidebar form to appear and click button to open
        // form to create calendar
        await waitForAndClick('[data-test-id="create-first-calendar-button"]')
        // wait for entity details sidebar to appear
        await waitForSelector('[data-test-id="calendar-service_id-input-container"]')

        // fill out form

        // service_id
        await type(
          '[data-test-id="calendar-service_id-input-container"] input',
          'test-service-id'
        )

        // description
        await type(
          '[data-test-id="calendar-description-input-container"] input',
          'test calendar'
        )

        // monday
        await click(
          '[data-test-id="calendar-monday-input-container"] input'
        )

        // tuesday
        await click(
          '[data-test-id="calendar-tuesday-input-container"] input'
        )

        // start date
        await clearAndType(
          '[data-test-id="calendar-start_date-input-container"] input',
          '05/29/18'
        )

        // end date
        await clearAndType(
          '[data-test-id="calendar-end_date-input-container"] input',
          '05/29/28'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for calendar sidebar form to appear
        await waitForSelector(
          '[data-test-id="calendar-service_id-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="calendar-service_id-input-container"]',
          'test-service-id'
        )
      }, defaultTestTimeout)

      makeEditorEntityTest('should update calendar data', async () => {
        // update calendar name by appending to end
        await appendText(
          '[data-test-id="calendar-description-input-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for calendar sidebar form to appear
        await waitForSelector(
          '[data-test-id="calendar-description-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="calendar-description-input-container"]',
          'test calendar updated'
        )
      }, defaultTestTimeout, 'should create calendar')

      makeEditorEntityTest('should delete calendar data', async () => {
        // create a new calendar that will get deleted
        await click('[data-test-id="clone-calendar-button"]')

        // update service id by appending to end
        await appendText(
          '[data-test-id="calendar-service_id-input-container"] input',
          '-copied'
        )

        // update description
        await appendText(
          '[data-test-id="calendar-description-input-container"] input',
          ' to delete'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for calendar sidebar form to appear
        await waitForSelector(
          '[data-test-id="calendar-description-input-container"] input'
        )

        // verify that calendar to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'test-service-id-copied (test calendar updated to delete)'
        )

        // delete the calendar
        await click('[data-test-id="delete-calendar-button"]')
        await waitForAndClick('[data-test-id="modal-confirm-ok-button"]')
        await wait(2000, 'for delete to happen')

        // verify that calendar to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'test-service-id-copied (test calendar updated to delete)'
        )
      }, defaultTestTimeout)
    })

    // ---------------------------------------------------------------------------
    // Exceptions tests
    // ---------------------------------------------------------------------------
    // all of the following editor tests assume the use of the scratch feed and
    // successful completion of the calendars test suite
    describe('exceptions', () => {
      makeEditorEntityTest('should create exception', async () => {
        // open exception sidebar
        await click('[data-test-id="exception-tab-button"]')

        // wait for exception sidebar form to appear and click button to open
        // form to create exception
        await waitForAndClick('[data-test-id="create-first-scheduleexception-button"]')
        // wait for entity details sidebar to appear
        await waitForSelector('[data-test-id="exception-name-input-container"]')

        // fill out form

        // name
        await type(
          '[data-test-id="exception-name-input-container"] input',
          'test exception'
        )

        // exception type
        await page.select(
          '[data-test-id="exception-type-input-container"] select',
          '7' // no service
        )

        // add exception date
        await click('[data-test-id="exception-add-date-button"]')
        await waitForSelector(
          '[data-test-id="exception-dates-container"] input'
        )
        await clearAndType(
          '[data-test-id="exception-dates-container"] input',
          '07/04/18'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for exception sidebar form to appear
        await waitForSelector(
          '[data-test-id="exception-name-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="exception-name-input-container"]',
          'test exception'
        )
      }, defaultTestTimeout, 'should create calendar')

      makeEditorEntityTest('should update exception data', async () => {
        // update exception name by appending to end
        await appendText(
          '[data-test-id="exception-name-input-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for exception sidebar form to appear
        await waitForSelector(
          '[data-test-id="exception-name-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="exception-name-input-container"]',
          'test exception updated'
        )
      }, defaultTestTimeout, 'should create exception')

      makeEditorEntityTest('should delete exception data', async () => {
        // create a new exception that will get deleted
        await click('[data-test-id="clone-scheduleexception-button"]')

        // update description
        await appendText(
          '[data-test-id="exception-name-input-container"] input',
          ' to delete'
        )

        // set new date
        await clearAndType(
          '[data-test-id="exception-dates-container"] input',
          '07/05/18'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for exception sidebar form to appear
        await waitForSelector(
          '[data-test-id="exception-name-input-container"] input'
        )

        // verify that exception to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'test exception updated to delete'
        )

        // delete the exception
        await click('[data-test-id="delete-scheduleexception-button"]')
        await waitForAndClick('[data-test-id="modal-confirm-ok-button"]')
        await wait(2000, 'for delete to happen')

        // verify that exception to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'test exception updated to delete'
        )
      }, defaultTestTimeout, 'should create calendar')
    })

    // ---------------------------------------------------------------------------
    // Fares tests
    // ---------------------------------------------------------------------------
    // all of the following editor tests assume the use of the scratch feed and
    // successful completion of the routes test suite
    describe('fares', () => {
      makeEditorEntityTest('should create fare', async () => {
        // open fare sidebar
        await click('[data-test-id="editor-fare-nav-button"]')

        // wait for fare sidebar form to appear and click button to open form
        // to create fare
        await waitForAndClick('[data-test-id="create-first-fare-button"]')
        // wait for entity details sidebar to appear
        await waitForSelector('[data-test-id="fare-fare_id-input-container"]')

        // fill out form

        // fare_id
        await type(
          '[data-test-id="fare-fare_id-input-container"] input',
          'test-fare-id'
        )

        // price
        await type(
          '[data-test-id="fare-price-input-container"] input',
          '1'
        )

        // currency
        await page.select(
          '[data-test-id="fare-currency_type-input-container"] select',
          'USD'
        )

        // payment method
        await page.select(
          '[data-test-id="fare-payment_method-input-container"] select',
          '0'
        )

        // transfers
        await page.select(
          '[data-test-id="fare-transfers-input-container"] select',
          '2'
        )

        // transfer duration
        await type(
          '[data-test-id="fare-transfer_duration-input-container"] input',
          '12345'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for fare sidebar form to appear
        await waitForSelector(
          '[data-test-id="fare-fare_id-input-container"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="fare-fare_id-input-container"]',
          'test-fare-id'
        )

        // add a fare rule
        await click('[data-test-id="fare-rules-tab-button"]')
        await waitForAndClick('[data-test-id="add-fare-rule-button"]')
        // select route type
        await waitForAndClick('input[name="fareRuleType-0-route_id"]')
        // select route
        await waitForSelector('[data-test-id="fare-rule-selections"] input')
        await reactSelectOption(
          '[data-test-id="fare-rule-selections"]',
          '1',
          1,
          true
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for fare sidebar form to appear
        await waitForSelector(
          '[data-test-id="fare-fare_id-input-container"]'
        )

        // go to rules tab
        await click('[data-test-id="fare-rules-tab-button"]')
        await waitForSelector('[data-test-id="add-fare-rule-button"]')

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="fare-rule-selections"]',
          'test route 1 updated'
        )
      }, defaultTestTimeout, 'should create route')

      makeEditorEntityTest('should update fare data', async () => {
        // browse back to fare attributes tab
        await click('[data-test-id="fare-attributes-tab-button"]')
        await waitForSelector('[data-test-id="fare-fare_id-input-container"]')

        // update fare id by appending to end
        await appendText(
          '[data-test-id="fare-fare_id-input-container"] input',
          '-updated'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for fare sidebar form to appear
        await waitForSelector(
          '[data-test-id="fare-fare_id-input-container"] input'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="fare-fare_id-input-container"]',
          'test-fare-id-updated'
        )
      }, defaultTestTimeout, 'should create fare')

      makeEditorEntityTest('should delete fare data', async () => {
        // create a new fare that will get deleted
        await click('[data-test-id="clone-fare-button"]')

        // update service id by appending to end
        await appendText(
          '[data-test-id="fare-fare_id-input-container"] input',
          '-copied'
        )

        // save
        await click('[data-test-id="save-entity-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for fare sidebar form to appear
        await waitForSelector(
          '[data-test-id="fare-fare_id-input-container"] input'
        )

        // verify that fare to delete is listed
        await expectSelectorToContainHtml(
          '.entity-list',
          'test-fare-id-updated-copied'
        )

        // delete the fare
        await click('[data-test-id="delete-fare-button"]')
        await waitForAndClick('[data-test-id="modal-confirm-ok-button"]')
        await wait(2000, 'for delete to happen')

        // verify that fare to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.entity-list',
          'test-fare-id-updated-copied'
        )
      }, defaultTestTimeout, 'should create fare')
    })

    // ---------------------------------------------------------------------------
    // Pattern tests
    // ---------------------------------------------------------------------------
    // all of the following editor tests assume the use of the scratch feed and
    // successful completion of the routes test suite
    describe('patterns', () => {
      makeEditorEntityTest('should create pattern', async () => {
        // open route sidebar
        await click('[data-test-id="editor-route-nav-button"]')

        // wait for route sidebar form to appear and select first route
        await waitForAndClick('.entity-list-row')
        // wait for route details sidebar to appear and go to trip pattern tab
        await waitForAndClick('[data-test-id="trippattern-tab-button"]')
        // wait for tab to load and click button to create pattern
        await waitForAndClick('[data-test-id="new-pattern-button"]')
        // wait for new pattern to appear
        await waitForSelector('[data-test-id="pattern-title-New Pattern"]')

        // toggle the FeedInfoPanel in case it gets in the way of panel stuff
        await click('[data-test-id="FeedInfoPanel-visibility-toggle"]')
        await wait(2000, 'for page to catch up with itself')

        // click add stop by name
        await click('[data-test-id="add-stop-by-name-button"]')

        // wait for stop selector to show up
        await waitForSelector('.pattern-stop-card .Select-control')

        // add 1st stop
        await reactSelectOption('.pattern-stop-card', 'la', 1, true)
        await wait(2000, 'for 1st stop to save')

        // add 2nd stop
        await reactSelectOption('.pattern-stop-card', 'ru', 1, true)
        await wait(2000, 'for auto-save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for pattern sidebar form to appear
        await waitForSelector(
          '[data-test-id="pattern-title-New Pattern"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '.trip-pattern-list',
          'Russell Av'
        )
      }, defaultTestTimeout, ['should create route', 'should create stop'])

      makeEditorEntityTest('should update pattern data', async () => {
        // change pattern name by appending to end
        // begin editing
        await click('[data-test-id="editable-text-field-edit-button"]')

        // wait for text field to appear
        await waitForSelector('[data-test-id="editable-text-field-edit-container"]')
        await appendText(
          '[data-test-id="editable-text-field-edit-container"] input',
          ' updated'
        )

        // save
        await click('[data-test-id="editable-text-field-edit-container"] button')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for pattern sidebar form to appear
        await waitForSelector(
          '[data-test-id="pattern-title-New Pattern updated"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="pattern-title-New Pattern updated"]',
          'New Pattern updated'
        )
      }, defaultTestTimeout, 'should create pattern')

      makeEditorEntityTest('should delete pattern data', async () => {
        // create a new pattern that will get deleted
        await click('[data-test-id="duplicate-pattern-button"]')
        await wait(2000, 'for save to happen')

        // verify that pattern to delete is listed
        await expectSelectorToContainHtml(
          '.trip-pattern-list',
          'New Pattern updated copy'
        )

        // delete the pattern
        await click('[data-test-id="delete-pattern-button"]')
        await waitForSelector('[data-test-id="modal-confirm-ok-button"]')
        await wait(2000, 'for page to catch up?')
        await click('[data-test-id="modal-confirm-ok-button"]')
        await wait(2000, 'for delete to happen')

        // verify that pattern to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '.trip-pattern-list',
          'New Pattern updated copy'
        )
      }, defaultTestTimeout, 'should create pattern')
    })

    // ---------------------------------------------------------------------------
    // Timetable tests
    // ---------------------------------------------------------------------------
    // all of the following editor tests assume the use of the scratch feed and
    // successful completion of the patterns and calendars test suites
    describe('timetables', () => {
      makeEditorEntityTest('should create trip', async () => {
        // expand pattern
        await click('[data-test-id="pattern-title-New Pattern updated"]')

        // wait for edit schedules button to appear and click edit schedules
        await waitForAndClick('[data-test-id="edit-schedules-button"]')
        // wait for calendar selector to appear
        await waitForSelector('[data-test-id="calendar-select-container"]')

        // select first calendar
        await reactSelectOption(
          '[data-test-id="calendar-select-container"]',
          'te',
          1
        )

        // wait for new trip button to appear
        await waitForSelector('[data-test-id="add-new-trip-button"]')
        await wait(2000, 'for page to catch up with itself?')

        // click button to create trip
        await click('[data-test-id="add-new-trip-button"]')

        // wait for new trip to appear
        await waitForSelector('[data-test-id="timetable-area"]')

        // click first cell to begin editing
        await click('.editable-cell')

        // enter block id
        await page.keyboard.type('test-block-id')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // trip id
        await page.keyboard.type('test-trip-id')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // trip headsign
        await page.keyboard.type('test-headsign')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // Laurel Dr arrival
        await page.keyboard.type('1234')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // Laurel Dr departure
        await page.keyboard.type('1235')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // Russell Av arrival
        await page.keyboard.type('1244')
        await page.keyboard.press('Tab')
        await page.keyboard.press('Enter')

        // Russell Av departure
        await page.keyboard.type('1245')
        await page.keyboard.press('Enter')

        // save
        await click('[data-test-id="save-trip-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for trip sidebar form to appear
        await waitForSelector(
          '[data-test-id="timetable-area"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="timetable-area"]',
          'test-trip-id'
        )
      }, defaultTestTimeout, ['should create calendar', 'should create pattern'])

      makeEditorEntityTest('should update trip data', async () => {
        // click first editable cell to begin editing
        await click('.editable-cell')

        // advance to right to trip id
        await page.keyboard.press('Tab')

        // change trip id by appending to end
        // begin editing
        await page.keyboard.press('Enter')
        await page.keyboard.press('End')
        await page.keyboard.type('-updated')
        await page.keyboard.press('Enter')

        // save
        await click('[data-test-id="save-trip-button"]')

        // wait for save to happen
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for timetable  to appear
        await waitForSelector(
          '[data-test-id="timetable-area"]'
        )

        // verify data was saved and retrieved from server
        await expectSelectorToContainHtml(
          '[data-test-id="timetable-area"]',
          'test-trip-id-updated'
        )
      }, defaultTestTimeout, 'should create trip')

      makeEditorEntityTest('should delete trip data', async () => {
        // create a new trip that will get deleted
        await click('[data-test-id="duplicate-trip-button"]')
        await wait(2000, 'for new trip to appear')

        // click first editable cell to begin editing
        await click('.editable-cell')

        // advance down and to right to trip id
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('ArrowRight')

        // change trip id by appending to end
        // begin editing
        await page.keyboard.press('Enter')
        await page.keyboard.type('test-trip-to-delete')
        await page.keyboard.press('Enter')
        await wait(2000, 'for save to happen')

        // save
        await click('[data-test-id="save-trip-button"]')
        await wait(2000, 'for save to happen')

        // reload to make sure stuff was saved
        await page.reload({ waitUntil: 'networkidle0' })

        // wait for timetable  to appear
        await waitForSelector(
          '[data-test-id="timetable-area"]'
        )

        // verify that trip to delete is listed
        await expectSelectorToContainHtml(
          '[data-test-id="timetable-area"]',
          'test-trip-to-delete'
        )

        // select the row
        await click('.timetable-left-grid .text-center:nth-child(2)')

        // delete the trip
        await click('[data-test-id="delete-trip-button"]')

        // confirm delete
        await waitForAndClick('[data-test-id="modal-confirm-ok-button"]')
        await wait(2000, 'for delete to happen')

        // verify that trip to delete is no longer listed
        await expectSelectorToNotContainHtml(
          '[data-test-id="timetable-area"]',
          'test-trip-to-delete'
        )
      }, defaultTestTimeout, 'should create trip')
    })

    // ---------------------------------------------------------------------------
    // Snapshot tests
    // ---------------------------------------------------------------------------
    // all of the following tests depend on the editor tests completing successfully
    describe('snapshot', () => {
      makeEditorEntityTest('should create snapshot', async () => {
        // open create snapshot dialog
        await click('[data-test-id="take-snapshot-button"]')

        // wait for dialog to appear
        await waitForSelector('[data-test-id="snapshot-dialog-name"]')

        // enter name
        await type('[data-test-id="snapshot-dialog-name"]', 'test-snapshot')

        // confrim snapshot creation
        await click('[data-test-id="confirm-snapshot-create-button"]')

        // wait for jobs to complete
        await waitAndClearCompletedJobs()
      }, defaultTestTimeout, 'should create trip')
    })
  })

  // ---------------------------------------------------------------------------
  // Feed Source Snapshot tests
  // ---------------------------------------------------------------------------
  describe('feed source snapshot', () => {
    makeEditorEntityTest('should make snapshot active version', async () => {
      // go back to feed
      // not sure why, but clicking on the nav home button doesn't work
      await goto(`http://localhost:9966/feed/${scratchFeedSourceId}`)

      // wait for page to be visible and go to snapshots tab
      await waitForAndClick('#feed-source-viewer-tabs-tab-snapshots')
      await wait(2000, 'for page to load?')

      // wait for snapshots tab to load and publish snapshot
      await waitForAndClick('[data-test-id="publish-snapshot-button"]')
      // wait for version to get created
      await waitAndClearCompletedJobs()

      // go to main feed tab
      await click('#feed-source-viewer-tabs-tab-')

      // wait for main tab to show up with version validity info
      await waitForSelector('[data-test-id="feed-version-validity"]')

      // verify that snapshot was made active version
      await expectSelectorToContainHtml(
        '[data-test-id="feed-version-validity"]',
        'Valid from May. 29, 2018 to May. 29, 2028'
      )
    }, defaultTestTimeout, 'should create snapshot')

    // TODO: download and validate gtfs??
  })

  // ---------------------------------------------------------------------------
  // Deployment tests
  // ---------------------------------------------------------------------------
  // the following tests depend on the snapshot test suite to have passed
  // successfully and also assumes a local instance of OTP is running
  describe('deployment', () => {
    makeTestPostFeedSource('should create deployment', async () => {
      // trigger creation of feed source-based deployment.
      await waitForAndClick('[data-test-id="deploy-feed-version-button"]')
      // wait for deploy dropdown button to appear and open dropdown
      await waitForSelector('#deploy-server-dropdown')
      await wait(2000, 'for dropdown to fully render')
      await click('#deploy-server-dropdown')
      // wait for dropdown to open and click to deploy to server
      await waitForAndClick('[data-test-id="deploy-server-0-button"]')
      // wait for deployment dialog to appear
      await waitForSelector('[data-test-id="confirm-deploy-server-button"]')

      // get the router name
      const innerHTML = await getInnerHTMLFromSelector(
        '[data-test-id="deployment-router-id"]'
      )
      // get rid of router id text and react tags
      routerId = innerHTML.replace('Router ID: ', '')

      // confirm deployment
      await click('[data-test-id="confirm-deploy-server-button"]')

      // wait for jobs to complete
      await waitAndClearCompletedJobs()
    }, defaultTestTimeout + 30000) // Add thirty seconds for deployment job

    makeEditorEntityTest('should be able to do a trip plan on otp', async () => {
      // hit the otp endpoint
      const response = await fetch(
        `${OTP_ROOT}${routerId}/plan?fromPlace=37.04532992924222%2C-122.07542181015015&toPlace=37.04899494106061%2C-122.07432746887208&time=12%3A32am&date=07-24-2018&mode=TRANSIT%2CWALK&maxWalkDistance=804.672&arriveBy=false&wheelchair=false&locale=en`,
        {
          headers: {
            'Content-Type': 'application/json; charset=utf-8'
          }
        }
      )

      // expect response to be successful
      expect(response.status).toBe(200)

      // expect response to include text of a created stop
      const text = await response.text()
      expect(text).toContain(dummyStop1.name)
    }, defaultTestTimeout, 'should create snapshot')
  })
})
