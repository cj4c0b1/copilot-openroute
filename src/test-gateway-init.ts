
import { OpenRouteGateway } from './OpenRouteGateway';

async function test() {
    console.log('Initializing Gateway...');
    const gateway = new OpenRouteGateway(9317);
    try {
        await gateway.start();
        console.log('Gateway started successfully.');

        await gateway.stop();
        console.log('Gateway stopped successfully.');
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

test();
