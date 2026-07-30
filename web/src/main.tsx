import { render } from 'preact'

import './design/longarm.css'
import { App } from './app/App'

const root = document.getElementById('root')
if (root) render(<App />, root)
