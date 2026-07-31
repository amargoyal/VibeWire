import { render } from 'preact'

import './design/nightshift.css'
import { App } from './app/App'

const root = document.getElementById('root')
if (root) render(<App />, root)
