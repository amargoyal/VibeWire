import { render } from 'preact'
import './dashboard.css'
import { App } from './App'
import { start } from './store'

start()
render(<App />, document.getElementById('root')!)
