import '@photobook/shared/fonts.css';
import '@photobook/shared/renderer.css';
import './styles.css';
import { render } from 'preact';
import { App } from './App';

const root = document.getElementById('app');
if (root) render(<App />, root);
