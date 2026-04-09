import React, { useEffect, useState } from 'react';
import { 
  AppProvider, 
  Page, 
  Layout, 
  Card, 
  Text, 
  BlockStack, 
  SkeletonBodyText, 
  SkeletonDisplayText,
  Icon,
  InlineStack,
  Badge,
  Button,
  EmptyState
} from '@shopify/polaris';
import { OrderIcon } from '@shopify/polaris-icons';
import translations from '@shopify/polaris/locales/en.json';
import axios from 'axios';
import './App.css';

function App() {
  const [orderCount, setOrderCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [shop, setShop] = useState(null);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const shopParam = urlParams.get('shop');
    
    if (!shopParam) {
      setLoading(false);
      return;
    }

    setShop(shopParam);

    const fetchOrderCount = async () => {
      try {
        const response = await axios.get(`/api/orders/count?shop=${shopParam}`);
        setOrderCount(response.data.count);
        setError(null);
      } catch (err) {
        if (err.response && err.response.status === 401) {
          setError('authentication_required');
        } else if (err.response && err.response.status === 403) {
          setError('permission_denied');
        } else if (err.response && err.response.data.message) {
          setError(`${err.response.data.message}`);
        } else {
          setError('Failed to fetch orders. Please check your internet or try re-installing.');
        }
        console.error('API Error:', err);
      } finally {
        setLoading(false);
      }
    };
    
    fetchOrderCount();

    const eventSource = new EventSource(`/api/orders/stream?shop=${shopParam}`);
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.count !== undefined) {
          setOrderCount(data.count);
        }
      } catch (e) {
        console.error('Error parsing SSE data', e);
      }
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const handleConnectStore = () => {
    const shopInput = prompt('Enter your Shopify store URL (e.g., your-store.myshopify.com):');
    if (shopInput) {
      window.location.href = `/api/auth?shop=${shopInput}`;
    }
  };

  const handleLogin = () => {
    if (shop) {
      window.location.href = `/api/auth?shop=${shop}`;
    }
  };

  // 1. Missing shop parameter state
  if (!shop && !loading) {
    return (
      <AppProvider i18n={translations}>
        <Page title="Connect Store">
          <Card>
            <EmptyState
              heading="Store Connection Required"
              action={{
                content: 'Connect your Shopify Store',
                onAction: handleConnectStore,
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Please enter your Shopify store URL to view your order dashboard.</p>
            </EmptyState>
          </Card>
        </Page>
      </AppProvider>
    );
  }

  // 2. Authentication required state
  if (error === 'authentication_required') {
    return (
      <AppProvider i18n={translations}>
        <Page title="Authentication Required">
          <Card>
            <EmptyState
              heading="Login Required"
              action={{
                content: `Log in to ${shop}`,
                onAction: handleLogin,
              }}
              secondaryAction={{
                content: 'Refresh Page',
                onAction: () => window.location.reload(),
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>Your session has expired or the shop is not authenticated. Please log in to your store to view real-time order data.</p>
            </EmptyState>
          </Card>
        </Page>
      </AppProvider>
    );
  }

  // 3. Permission denied state
  if (error === 'permission_denied') {
    return (
      <AppProvider i18n={translations}>
        <Page title="Permission Denied">
          <Card>
            <EmptyState
              heading="Permissions Required"
              action={{
                content: 'Re-install App',
                onAction: handleLogin,
              }}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>The app needs additional permissions (read_orders) to display your dashboard. Please click below to update the app.</p>
            </EmptyState>
          </Card>
        </Page>
      </AppProvider>
    );
  }

  return (
    <AppProvider i18n={translations}>
      <div className="app-container">
        <Page title="Order Count Dashboard" subtitle={`Connected to ${shop}`}>
          <Layout>
            <Layout.Section>
              <div className="dashboard-card-wrapper">
                <Card roundedAbove="sm">
                  <div style={{ padding: '24px' }}>
                    <BlockStack gap="400">
                      <InlineStack align="space-between">
                        <Text as="h2" variant="headingLg">
                          Total Orders
                        </Text>
                        <Badge tone="success">Live Syncing</Badge>
                      </InlineStack>
                      
                      {loading ? (
                        <div className="loading-state">
                          <BlockStack gap="400">
                            <SkeletonDisplayText size="large" />
                            <SkeletonBodyText lines={2} />
                          </BlockStack>
                        </div>
                      ) : error ? (
                        <div className="error-state">
                          <Text as="p" tone="critical">{error}</Text>
                          <div style={{ marginTop: '16px' }}>
                            <Button onClick={() => window.location.reload()}>Retry Connection</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="stat-display">
                          <InlineStack wrap={false} align="start" blockAlign="center" gap="400">
                            <div className="icon-wrapper">
                              <Icon source={OrderIcon} tone="base" />
                            </div>
                            <BlockStack gap="100">
                              <Text as="p" variant="heading3xl" fontWeight="bold">
                                {(orderCount || 0).toLocaleString()}
                              </Text>
                              <Text as="p" variant="bodyMd" tone="subdued">
                                Lifetime orders from your store
                              </Text>
                            </BlockStack>
                          </InlineStack>
                        </div>
                      )}
                    </BlockStack>
                  </div>
                </Card>
              </div>
            </Layout.Section>
          </Layout>
        </Page>
      </div>
    </AppProvider>
  );
}

export default App;
