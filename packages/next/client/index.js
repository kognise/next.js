import React, { Suspense } from 'react'
import ReactDOM from 'react-dom'
import HeadManager from './head-manager'
import { createRouter, makePublicRouterInstance } from 'next/router'
import mitt from 'next-server/dist/lib/mitt'
import { loadGetInitialProps, getURL } from 'next-server/dist/lib/utils'
import PageLoader from './page-loader'
import * as envConfig from 'next-server/config'
import Loadable from 'next-server/dist/lib/loadable'
import { HeadManagerContext } from 'next-server/dist/lib/head-manager-context'
import { DataManagerContext } from 'next-server/dist/lib/data-manager-context'
import { RouterContext } from 'next-server/dist/lib/router-context'
import { DataManager } from 'next-server/dist/lib/data-manager'
import { parse as parseQs, stringify as stringifyQs } from 'querystring'
import { isDynamicRoute } from 'next-server/dist/lib/router/utils'

// Polyfill Promise globally
// This is needed because Webpack's dynamic loading(common chunks) code
// depends on Promise.
// So, we need to polyfill it.
// See: https://webpack.js.org/guides/code-splitting/#dynamic-imports
if (!window.Promise) {
  window.Promise = Promise
}

const data = JSON.parse(document.getElementById('__NEXT_DATA__').textContent)
window.__NEXT_DATA__ = data

const {
  props,
  err,
  page,
  query,
  buildId,
  dynamicBuildId,
  assetPrefix,
  runtimeConfig,
  dynamicIds
} = data

const d = JSON.parse(window.__NEXT_DATA__.dataManager)
export const dataManager = new DataManager(d)

const prefix = assetPrefix || ''

// With dynamic assetPrefix it's no longer possible to set assetPrefix at the build time
// So, this is how we do it in the client side at runtime
__webpack_public_path__ = `${prefix}/_next/` //eslint-disable-line
// Initialize next/config with the environment configuration
envConfig.setConfig({
  serverRuntimeConfig: {},
  publicRuntimeConfig: runtimeConfig
})

const asPath = getURL()

const pageLoader = new PageLoader(buildId, prefix)
const register = ([r, f]) => pageLoader.registerPage(r, f)
if (window.__NEXT_P) {
  window.__NEXT_P.map(register)
}
window.__NEXT_P = []
window.__NEXT_P.push = register

const headManager = new HeadManager()
const appContainer = document.getElementById('__next')

let lastAppProps
let webpackHMR
export let router
export let ErrorComponent
let Component
let App

class Container extends React.Component {
  componentDidCatch (err, info) {
    this.props.fn(err, info)
  }

  componentDidMount () {
    this.scrollToHash()

    // If page was exported and has a querystring
    // If it's a dynamic route (/$ inside) or has a querystring
    if (
      data.nextExport &&
      (isDynamicRoute(router.pathname) || window.location.search)
    ) {
      // update query on mount for exported pages
      router.replace(
        router.pathname +
          '?' +
          stringifyQs({
            ...router.query,
            ...parseQs(window.location.search.substr(1))
          }),
        asPath
      )
    }
  }

  componentDidUpdate () {
    this.scrollToHash()
  }

  scrollToHash () {
    let { hash } = window.location
    hash = hash && hash.substring(1)
    if (!hash) return

    const el = document.getElementById(hash)
    if (!el) return

    // If we call scrollIntoView() in here without a setTimeout
    // it won't scroll properly.
    setTimeout(() => el.scrollIntoView(), 0)
  }

  render () {
    return this.props.children
  }
}

export const emitter = mitt()

export default async ({ webpackHMR: passedWebpackHMR } = {}) => {
  // This makes sure this specific lines are removed in production
  if (process.env.NODE_ENV === 'development') {
    webpackHMR = passedWebpackHMR
  }
  App = await pageLoader.loadPage('/_app')

  let initialErr = err

  try {
    Component = await pageLoader.loadPage(page)

    if (process.env.NODE_ENV !== 'production') {
      const { isValidElementType } = require('react-is')
      if (!isValidElementType(Component)) {
        throw new Error(
          `The default export is not a React Component in page: "${page}"`
        )
      }
    }
  } catch (error) {
    // This catches errors like throwing in the top level of a module
    initialErr = error
  }

  await Loadable.preloadReady(dynamicIds || [])

  if (dynamicBuildId === true) {
    pageLoader.onDynamicBuildId()
  }

  router = createRouter(page, query, asPath, {
    initialProps: props,
    pageLoader,
    App,
    Component,
    err: initialErr,
    subscription: ({ Component, props, err }, App) => {
      render({ App, Component, props, err, emitter })
    }
  })

  render({ App, Component, props, err: initialErr, emitter })

  return emitter
}

export async function render (props) {
  if (props.err) {
    await renderError(props)
    return
  }

  try {
    await doRender(props)
  } catch (err) {
    await renderError({ ...props, err })
  }
}

// This method handles all runtime and debug errors.
// 404 and 500 errors are special kind of errors
// and they are still handle via the main render method.
export async function renderError (props) {
  const { App, err } = props

  if (process.env.NODE_ENV !== 'production') {
    return webpackHMR.reportRuntimeError(webpackHMR.prepareError(err))
  }

  // Make sure we log the error to the console, otherwise users can't track down issues.
  console.error(err)

  ErrorComponent = await pageLoader.loadPage('/_error')

  // In production we do a normal render with the `ErrorComponent` as component.
  // If we've gotten here upon initial render, we can use the props from the server.
  // Otherwise, we need to call `getInitialProps` on `App` before mounting.
  const initProps = props.props
    ? props.props
    : await loadGetInitialProps(App, {
      Component: ErrorComponent,
      router,
      ctx: { err, pathname: page, query, asPath }
    })

  await doRender({ ...props, err, Component: ErrorComponent, props: initProps })
}

// If hydrate does not exist, eg in preact.
let isInitialRender = typeof ReactDOM.hydrate === 'function'
function renderReactElement (reactEl, domEl) {
  // The check for `.hydrate` is there to support React alternatives like preact
  if (isInitialRender) {
    ReactDOM.hydrate(reactEl, domEl)
    isInitialRender = false
  } else {
    ReactDOM.render(reactEl, domEl)
  }
}

async function doRender ({ App, Component, props, err }) {
  // Usual getInitialProps fetching is handled in next/router
  // this is for when ErrorComponent gets replaced by Component by HMR
  if (
    !props &&
    Component &&
    Component !== ErrorComponent &&
    lastAppProps.Component === ErrorComponent
  ) {
    const { pathname, query, asPath } = router
    props = await loadGetInitialProps(App, {
      Component,
      router,
      ctx: { err, pathname, query, asPath }
    })
  }

  Component = Component || lastAppProps.Component
  props = props || lastAppProps.props

  const appProps = { Component, err, router, ...props }
  // lastAppProps has to be set before ReactDom.render to account for ReactDom throwing an error.
  lastAppProps = appProps

  emitter.emit('before-reactdom-render', {
    Component,
    ErrorComponent,
    appProps
  })

  // In development runtime errors are caught by react-error-overlay.
  if (process.env.NODE_ENV === 'development') {
    renderReactElement(
      <Container
        fn={error =>
          renderError({ App, err: error }).catch(err =>
            console.error('Error rendering page: ', err)
          )
        }
      >
        <Suspense fallback={<div>Loading...</div>}>
          <RouterContext.Provider value={makePublicRouterInstance(router)}>
            <DataManagerContext.Provider value={dataManager}>
              <HeadManagerContext.Provider value={headManager.updateHead}>
                <App {...appProps} />
              </HeadManagerContext.Provider>
            </DataManagerContext.Provider>
          </RouterContext.Provider>
        </Suspense>
      </Container>,
      appContainer
    )
  } else {
    // In production we catch runtime errors using componentDidCatch which will trigger renderError.
    renderReactElement(
      <Container
        fn={error =>
          renderError({ App, err: error }).catch(err =>
            console.error('Error rendering page: ', err)
          )
        }
      >
        <Suspense fallback={<div>Loading...</div>}>
          <RouterContext.Provider value={makePublicRouterInstance(router)}>
            <DataManagerContext.Provider value={dataManager}>
              <HeadManagerContext.Provider value={headManager.updateHead}>
                <App {...appProps} />
              </HeadManagerContext.Provider>
            </DataManagerContext.Provider>
          </RouterContext.Provider>
        </Suspense>
      </Container>,
      appContainer
    )
  }

  emitter.emit('after-reactdom-render', { Component, ErrorComponent, appProps })
}
