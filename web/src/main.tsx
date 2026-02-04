import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app'
import { ErrorBoundary } from './components/error-boundary'
import '@fontsource/geist/400.css'
import '@fontsource/geist/500.css'
import '@fontsource/geist/600.css'
import '@fontsource/geist-mono/400.css'
import './styles/globals.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<ErrorBoundary>
			<App />
		</ErrorBoundary>
	</React.StrictMode>,
)
